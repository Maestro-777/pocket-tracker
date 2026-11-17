(() => {
  "use strict";
  const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
  function heikinAshi(rows){
    let po=null,pc=null;
    return rows.map(c=>{
      const close=(c.open+c.high+c.low+c.close)/4;
      const open=po===null?(c.open+c.close)/2:(po+pc)/2;
      const out={time:c.time,open,high:Math.max(c.high,open,close),low:Math.min(c.low,open,close),close};
      po=open;pc=close;return out;
    });
  }
  function vectorize(rows){
    const ha=heikinAshi(rows);
    return ha.map(c=>{
      const range=Math.max(c.high-c.low,1e-12),body=c.close-c.open;
      return [body/range,(c.high-Math.max(c.open,c.close))/range,
        (Math.min(c.open,c.close)-c.low)/range,Math.sign(body),Math.log(range)];
    });
  }
  function score(a,b){
    if(a.length!==b.length||!a.length)return 0;
    let total=0;
    for(let i=0;i<a.length;i++){
      const x=a[i],y=b[i];
      const shape=(Math.abs(x[0]-y[0])+Math.abs(x[1]-y[1])+Math.abs(x[2]-y[2]))/3;
      const color=x[3]===y[3]?0:1;
      const range=clamp(Math.abs(x[4]-y[4])/3,0,1);
      total+=1-(.62*shape+.23*color+.15*range);
    }
    return clamp(total/a.length,0,1);
  }
  function isContinuous(candles,start,size,step){
    for(let j=start+1;j<start+size;j++)if(candles[j].time-candles[j-1].time!==step)return false;
    return true;
  }
  function findSimilar(candles,opts={}){
    const length=Math.max(4,Math.min(50,Number(opts.patternLength)||8));
    const limit=Math.max(1,Math.min(50,Number(opts.resultLimit)||10));
    const threshold=clamp((Number(opts.threshold)||80)/100,.5,.99);
    if(candles.length<length*2+1)return {status:"warming",message:"Для такого паттерна пока мало свечей.",matches:[],count:candles.length,patternLength:length,validWindows:0};
    const features=vectorize(candles),end=features.length,queryStart=end-length,query=features.slice(queryStart);
    const step=Number(candles.at(-1)?.period||5)*1000;
    if(!isContinuous(candles,queryStart,length,step))return {status:"gaps",message:"В последних свечах есть пропуски по времени.",matches:[],count:candles.length,patternLength:length,validWindows:0};
    const matches=[];let validWindows=0,skippedGaps=0;
    for(let i=length;i<=end-length;i++){
      const start=i-length;
      if(!isContinuous(candles,start,length,step)||candles[i].time-candles[i-1].time!==step){skippedGaps++;continue;}
      validWindows++;const similarity=score(query,features.slice(start,i));
      if(similarity>=threshold){
        const previous=candles[i-1]?.close,next=candles[i]?.close;
        matches.push({index:start,time:candles[start]?.time,similarity,
          nextDirection:next==null||previous==null?"UNKNOWN":next>previous?"UP":next<previous?"DOWN":"FLAT"});
      }
    }
    matches.sort((a,b)=>b.similarity-a.similarity);
    return {status:"ready",count:candles.length,patternLength:length,threshold:threshold*100,
      validWindows,skippedGaps,totalMatches:matches.length,matches:matches.slice(0,limit)};
  }

  // Scores historical analogues only after their complete +expiry horizon is available.
  // A candidate is never scored using candles that belong to the current query pattern.
  function evaluateExpiry(candles,opts={}){
    const expirySec=Math.max(1,Math.min(300,Number(opts.expirySec)||10));
    const threshold=clamp((Number(opts.threshold)||80)/100,.5,.99);
    const minSamples=Math.max(5,Math.min(200,Number(opts.minSamples)||20));
    const lengths=(opts.lengths||[8,10,12,16,20,24,30,40]).map(Number).filter(n=>n>=4&&n<=50);
    if(!candles.length)return {status:"warming",message:"Нет свечей.",expirySec};
    const period=Number(candles.at(-1).period||5),step=period*1000;
    const features=vectorize(candles),end=candles.length,results=[];
    for(const length of lengths){
      if(end<length*2+2)continue;
      const qStart=end-length;
      if(!isContinuous(candles,qStart,length,step))continue;
      const query=features.slice(qStart),last=candles[end-1];
      let up=0,down=0,flat=0,valid=0,skipped=0;
      for(let start=0;start+length<qStart;start++){
        if(!isContinuous(candles,start,length,step)){skipped++;continue;}
        const patternEnd=candles[start+length-1];
        const targetTime=patternEnd.time+expirySec*1000;
        let target=start+length;
        while(target<qStart&&candles[target].time<targetTime)target++;
        if(target>=qStart||candles[target].time<targetTime)continue;
        if(candles[target].time-targetTime>step)continue;
        const similarity=score(query,features.slice(start,start+length));
        if(similarity<threshold)continue;
        const delta=Number(candles[target].close)-Number(patternEnd.close);
        if(!Number.isFinite(delta)||!Number.isFinite(Number(patternEnd.close)))continue;
        valid++;
        if(delta>0)up++;else if(delta<0)down++;else flat++;
      }
      const directional=up+down,winRate=directional?(Math.max(up,down)/directional):0;
      results.push({patternLength:length,samples:valid,up,down,flat,winRate,
        direction:up>down?"UP":down>up?"DOWN":"FLAT",skipped});
    }
    results.sort((a,b)=>{
      const aEligible=a.samples>=minSamples,bEligible=b.samples>=minSamples;
      if(aEligible!==bEligible)return aEligible?-1:1;
      return (b.winRate-a.winRate) || (b.samples-a.samples);
    });
    const chosen=results.find(r=>r.samples>=minSamples);
    if(!chosen)return {status:"insufficient",message:"Недостаточно исторических совпадений с известным исходом на горизонте экспирации. Сигнал не формируется.",expirySec,minSamples,results};
    const edge=chosen.winRate-.5;
    const signal=chosen.winRate>=.58?chosen.direction:"WAIT";
    return {status:"ready",expirySec,minSamples,threshold:threshold*100,chosen,signal,
      queryTime:last.time,results,disclaimer:"Историческая частота на похожих участках не гарантирует будущий результат и не является вероятностью выигрыша."};
  }
  globalThis.PocketCollectorEngine={heikinAshi,vectorize,findSimilar,evaluateExpiry};
})();