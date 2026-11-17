/* Pocket Tracker 4.0 — Predictive Chart Engine
 * Uses Pocket Option's own OTC quote stream only.
 * Forecasts are immutable at issue time; evaluation happens only after horizon expiry.
 */
(function (root) {
  'use strict';
  if (root.PT4PredictiveEngine) return;

  const HORIZONS = [60, 120, 180, 240, 300];
  const MODEL_IDS = ['linear', 'exponential', 'polynomial', 'momentum', 'cyclical', 'ensemble'];
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
  const variance = a => { const m = mean(a); return mean(a.map(x => (x - m) ** 2)); };

  class PredictiveEngine {
    constructor(options = {}) {
      this.options = Object.assign({ enabled: true, minSamples: 80, maxTicks: 12000, maxForecasts: 3000, confidenceFloor: 0.52, forecastIntervalMs: 1000, minEvaluationSamples: 20 }, options);
      this.series = new Map();
      this.pending = new Map();
      this.history = [];
      this.listeners = new Set();
      this.stats = new Map();
      this.lastForecastAt = new Map();
    }
    onUpdate(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    emit(type, data) { for (const fn of this.listeners) { try { fn(type, data); } catch (_) {} } }
    _key(asset) { return String(asset || '').toUpperCase(); }
    _isOtc(asset) { return /(?:_OTC| OTC)$/i.test(String(asset || '')); }
    ingest(tick) {
      if (!this.options.enabled || !tick || !this._isOtc(tick.asset)) return null;
      const asset = this._key(tick.asset), price = Number(tick.price), timestamp = Number(tick.timestamp) || Date.now();
      if (!(price > 0) || !Number.isFinite(price)) return null;
      let s = this.series.get(asset);
      if (!s) { s = []; this.series.set(asset, s); }
      const last = s[s.length - 1];
      if (last && timestamp < last.t) return null;
      if (last && timestamp === last.t && price === last.p) return null;
      s.push({ t: timestamp, p: price });
      if (s.length > this.options.maxTicks) s.splice(0, s.length - this.options.maxTicks);
      this._settle(asset, timestamp, price);
      if (s.length < this.options.minSamples) return null;
      return this.forecast(asset, timestamp);
    }
    _returns(s) {
      const out = [];
      for (let i = 1; i < s.length; i++) {
        const dt = Math.max(1, s[i].t - s[i - 1].t);
        out.push({ t: s[i].t, r: (s[i].p - s[i - 1].p) / s[i - 1].p, dt });
      }
      return out;
    }
    _features(s) {
      const recent = s.slice(-240), rets = this._returns(recent);
      const perSec = rets.map(x => x.r / (x.dt / 1000));
      const v = mean(perSec.slice(-30)), a = perSec.length > 2 ? mean(perSec.slice(-10)) - mean(perSec.slice(-30, -10)) : 0;
      const vol = Math.sqrt(variance(perSec.slice(-60)));
      return { v, a, vol, rets, recent };
    }
    _predict(model, s, horizonMs) {
      const f = this._features(s), p = s[s.length - 1].p, h = horizonMs / 1000;
      const recent = s.slice(-120), values = recent.map(x => x.p);
      const n = values.length, dt = Math.max(0.001, (recent[n-1].t - recent[0].t) / 1000);
      const slope = n > 1 ? (values[n-1] - values[0]) / dt : 0;
      if (model === 'linear') return p + slope * h + 0.5 * f.a * p * h * h;
      if (model === 'exponential') {
        let level = values[0], trend = 0;
        for (let i=1;i<n;i++) { const d=values[i]-level; level += 0.24*d; trend = 0.18*d + 0.82*trend; }
        return p + trend * (h / Math.max(1, dt / Math.max(1,n-1)));
      }
      if (model === 'polynomial') {
        const m = Math.min(30, n), x = [], y = [];
        for (let i=n-m;i<n;i++) { x.push((recent[i].t-recent[n-1].t)/1000); y.push(recent[i].p); }
        const sx=mean(x), sy=mean(y), sxx=mean(x.map(z=>(z-sx)**2)), sxy=mean(x.map((z,i)=>(z-sx)*(y[i]-sy)));
        const b=sxx ? sxy/sxx : 0, c=sy-b*sx;
        const residual=y.map((z,i)=>z-(c+b*x[i]));
        const curvature=residual.length>2 ? (residual[residual.length-1]-residual[0])/Math.max(1,dt) : 0;
        return c + b*h + 0.5*curvature*h*h;
      }
      if (model === 'momentum') {
        const r=f.rets.slice(-40).map(x=>x.r), fast=mean(r.slice(-8)), slow=mean(r);
        return p * (1 + (fast*0.65 + slow*0.35) * Math.sqrt(h));
      }
      if (model === 'cyclical') {
        const r=f.rets.slice(-80).map(x=>x.r);
        let bestLag=0,best=-Infinity;
        for(let lag=2;lag<=Math.min(24,Math.floor(r.length/3));lag++) {
          let c=0; for(let i=lag;i<r.length;i++) c+=r[i]*r[i-lag];
          if(c>best){best=c;bestLag=lag;}
        }
        const amp=mean(r.slice(-bestLag).map(Math.abs));
        const direction=bestLag ? Math.sign(r[r.length-bestLag] || mean(r)) : Math.sign(mean(r));
        return p * (1 + direction * amp * Math.sin((h/Math.max(1,bestLag/3))*Math.PI) * Math.sqrt(h));
      }
      return p;
    }
    _allPredictions(s, horizon) {
      const out = {};
      for (const id of MODEL_IDS.filter(x=>x!=='ensemble')) {
        try { const value=this._predict(id,s,horizon); if(Number.isFinite(value)&&value>0) out[id]=value; } catch (_) {}
      }
      const ranked = Object.keys(out).map(id=>({id,score:this._score(id, horizon)})).sort((a,b)=>a.score-b.score);
      const top=ranked.slice(0,3), weights=top.map(x=>1/Math.max(1e-12,x.score));
      if(top.length) out.ensemble=top.reduce((sum,x,i)=>sum+out[x.id]*weights[i],0)/weights.reduce((a,b)=>a+b,0);
      return {predictions:out, ranked};
    }
    _statKey(asset,horizon,model){return asset+'|'+horizon+'|'+model;}
    _score(model,horizon,asset) {
      if(asset) { const st=this.stats.get(this._statKey(asset,horizon,model)); return st&&st.n ? 1-(st.wins/st.n) : Infinity; }
      let wins=0,n=0; for(const [k,st] of this.stats) if(k.endsWith('|'+horizon+'|'+model)&&st.n){wins+=st.wins;n+=st.n;}
      return n?1-(wins/n):Infinity;
    }
    forecast(asset, now = Date.now()) {
      const s=this.series.get(asset); if(!s || s.length<this.options.minSamples) return null;
      const previous=this.lastForecastAt.get(asset)||0;
      if(now-previous<this.options.forecastIntervalMs) return null;
      this.lastForecastAt.set(asset,now);
      const current=s[s.length-1].p, horizons={};
      for(const horizon of HORIZONS) {
        const {predictions,ranked}=this._allPredictions(s,horizon);
        const eligible=ranked.filter(x=>{const st=this.stats.get(this._statKey(asset,horizon,x.id));return st&&st.n>=this.options.minEvaluationSamples;});
        const best=eligible.sort((a,b)=>this._score(a.id,horizon,asset)-this._score(b.id,horizon,asset))[0];
        const selected=best ? best.id : 'ensemble';
        const target=predictions[selected] ?? predictions.ensemble ?? current;
        const delta=(target-current)/current;
        const vol=this._features(s).vol*Math.sqrt(horizon/1000);
        const confidence=clamp(0.5+Math.abs(delta)/(Math.abs(delta)+Math.max(vol,1e-8)),0.5,0.95);
        horizons[horizon]={horizonSeconds:horizon/1000,price:target,direction:delta>0?'UP':delta<0?'DOWN':'NEUTRAL',model:selected,confidence,models:predictions};
        const id=asset+'|'+horizon+'|'+now;
        this.pending.set(id,{id,asset,horizon,issuedAt:now,entry:current,predicted:target,direction:horizons[horizon].direction,model:selected,models:predictions});
      }
      while(this.pending.size>this.options.maxForecasts) this.pending.delete(this.pending.keys().next().value);
      const result={asset, timestamp:now,currentPrice:current,horizons};
      this.emit('forecast',result); return result;
    }
    _settle(asset, now, price) {
      for(const [id,f] of this.pending) {
        if(f.asset!==asset || now < f.issuedAt+f.horizon) continue;
        const actualDirection=price>f.entry?'UP':price<f.entry?'DOWN':'NEUTRAL';
        const correct=actualDirection===f.direction;
        const actualError=Math.abs(price-f.predicted)/f.entry;
        for(const model of Object.keys(f.models)) {
          const predictedDirection=f.models[model]>f.entry?'UP':f.models[model]<f.entry?'DOWN':'NEUTRAL';
          const key=this._statKey(asset,f.horizon,model), st=this.stats.get(key)||{n:0,wins:0,loss:0};
          st.n++; if(predictedDirection===actualDirection) st.wins++;
          st.loss += Math.abs(price-f.models[model])/f.entry;
          this.stats.set(key,st);
        }
        const record=Object.assign({},f,{settledAt:now,actualPrice:price,actualDirection,correct,actualError});
        this.history.push(record); if(this.history.length>this.options.maxForecasts) this.history.shift();
        this.pending.delete(id); this.emit('settled',record);
      }
    }
    getStats(asset) {
      const rows=[];
      for(const horizon of HORIZONS) for(const model of MODEL_IDS) {
        const st=this.stats.get(this._statKey(asset,horizon,model))||{n:0,wins:0,loss:0};
        rows.push({asset,horizonSeconds:horizon/1000,model,samples:st.n,accuracy:st.n?st.wins/st.n:0,meanAbsoluteError:st.n?st.loss/st.n:0});
      }
      return rows;
    }
    getHistory(limit=100) { return this.history.slice(-limit); }
  }

  root.PT4PredictiveEngine = PredictiveEngine;
  root.addEventListener('message', event => {
    const d=event.data;
    if(!d || d.type!=='PT4_PREDICTIVE_CONFIG') return;
    if(d.config && typeof d.config.enabled==='boolean') root.__pt4PredictiveEngine.options.enabled=d.config.enabled;
    if(d.config && Number.isFinite(Number(d.config.minSamples))) root.__pt4PredictiveEngine.options.minSamples=clamp(Number(d.config.minSamples),30,2000);
  });
  root.__pt4PredictiveEngine = root.__pt4PredictiveEngine || new PredictiveEngine();
  // inject.js already publishes each raw Pocket Option tick through this same-page message.
  root.addEventListener('message', event => {
    const d=event.data;
    if(!d || d.type!=='POROBOT_WS_PRICE' || !d.asset || !/_otc$/i.test(d.asset)) return;
    const result=root.__pt4PredictiveEngine.ingest(d);
    if(result) root.postMessage({type:'POROBOT_PREDICTIVE_UPDATE',forecast:result},'*');
  });
})(window);
