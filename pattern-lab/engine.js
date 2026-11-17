// Pattern Lab: deterministic, non-lookahead pattern research engine.
(() => {
  const clamp = (x,a,b)=>Math.max(a,Math.min(b,x));
  function heikinAshi(candles){
    let prevOpen=null,prevClose=null;
    return candles.map(c=>{
      const close=(c.open+c.high+c.low+c.close)/4;
      const open=prevOpen===null?(c.open+c.close)/2:(prevOpen+prevClose)/2;
      const high=Math.max(c.high,open,close), low=Math.min(c.low,open,close);
      prevOpen=open; prevClose=close;
      return {time:c.time,open,high,low,close,volume:c.volume||0};
    });
  }
  function features(candles){
    const ha=heikinAshi(candles);
    const ranges=ha.map(c=>Math.max(c.high-c.low,1e-12));
    const out=[];
    for(let i=0;i<ha.length;i++){
      const c=ha[i],range=ranges[i],body=c.close-c.open;
      out.push([body/range,(c.high-Math.max(c.open,c.close))/range,(Math.min(c.open,c.close)-c.low)/range,
        Math.sign(body),Math.log(range)]);
    }
    // Normalize range-size feature against the current window, not future bars.
    return out;
  }
  function similarity(a,b){
    if(a.length!==b.length||!a.length)return 0;
    let total=0;
    for(let i=0;i<a.length;i++){
      const x=a[i],y=b[i];
      const d=(Math.abs(x[0]-y[0])+Math.abs(x[1]-y[1])+Math.abs(x[2]-y[2]))/3;
      const color=x[3]===y[3]?0:1;
      const vol=clamp(Math.abs(x[4]-y[4])/3,0,1);
      total+=1-(.62*d+.23*color+.15*vol);
    }
    return clamp(total/a.length,0,1);
  }
  function analyze(candles,opts={}){
    const lookback=opts.lookback||8, threshold=(opts.threshold??80)/100;
    const minSamples=opts.minSamples||30, horizons=opts.horizons||[1,2,3,4,6,8,10];
    if(candles.length<Math.max(lookback*2+minSamples+Math.max(...horizons),100))
      return {status:"warming",message:"Недостаточно истории для независимой проверки",samples:candles.length};
    const f=features(candles), end=f.length-lookback;
    const query=f.slice(end,end+lookback), matches=[];
    // Candidate windows end before the live query; their forward outcomes must also
    // finish before the query to avoid leakage.
    for(let i=lookback;i<end-Math.max(...horizons);i++){
      const score=similarity(query,f.slice(i-lookback,i));
      if(score>=threshold){
        const start=i, entry=candles[i].close;
        const outcomes={};
        for(const h of horizons){
          const exit=candles[i+h]?.close;
          if(exit==null)continue;
          outcomes[h]=Math.sign(exit-entry);
        }
        matches.push({index:i,score,outcomes});
      }
    }
    if(matches.length<minSamples)return {status:"insufficient",message:"Мало исторических аналогов — сигнал заблокирован",matches:matches.length,minSamples};
    const stats=horizons.map(h=>{
      const rows=matches.filter(m=>m.outcomes[h]!==undefined);
      const up=rows.filter(m=>m.outcomes[h]>0).length;
      const down=rows.filter(m=>m.outcomes[h]<0).length;
      const flat=rows.length-up-down;
      const direction=up>=down?"CALL":"PUT";
      const wins=Math.max(up,down);
      return {horizon:h,direction,winRate:rows.length?wins/rows.length:0,count:rows.length,up,down,flat};
    }).filter(s=>s.count>=minSamples).sort((a,b)=>b.winRate-a.winRate);
    const best=stats[0];
    if(!best)return {status:"insufficient",message:"Недостаточно завершённых исходов",matches:matches.length};
    const avg=matches.reduce((s,m)=>s+m.score,0)/matches.length;
    return {status:"ready",similarity:avg,matchCount:matches.length,best,stats,signal:best.winRate>=.8?best.direction:null,
      note:"Историческая доля исходов — не гарантия будущего результата. Проверьте на paper/demo."};
  }
  globalThis.PatternLabEngine={heikinAshi,features,similarity,analyze};
})();