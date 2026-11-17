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
        (Math.min(c.open,c.close)-c.low)/range,Math.sign(body),
        Math.log(range)];
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
  function findSimilar(candles,opts={}){
    const length=Math.max(4,Math.min(50,Number(opts.patternLength)||8));
    const limit=Math.max(1,Math.min(50,Number(opts.resultLimit)||10));
    const threshold=clamp((Number(opts.threshold)||80)/100,.5,.99);
    if(candles.length<length*2+1)return {status:"warming",message:"Для такого паттерна пока мало свечей.",matches:[],count:candles.length,patternLength:length,validWindows:0};
    const features=vectorize(candles),end=features.length;
    const queryStart=end-length,query=features.slice(queryStart);
    const step=Number(candles.at(-1)?.period||5)*1000;
    const continuous=(start,size)=> {
      for(let j=start+1;j<start+size;j++){
        if(candles[j].time-candles[j-1].time!==step)return false;
      }
      return true;
    };
    if(!continuous(queryStart,length)){
      return {status:"gaps",message:"В последних свечах есть пропуски по времени. Дождитесь непрерывного участка или уменьшите длину паттерна.",matches:[],count:candles.length,patternLength:length,validWindows:0};
    }
    const matches=[];
    let validWindows=0,skippedGaps=0;
    // Only compare complete, time-contiguous historical windows that do not overlap the current pattern.
    for(let i=length;i<=end-length;i++){
      const start=i-length;
      if(!continuous(start,length)||candles[i].time-candles[i-1].time!==step){skippedGaps++;continue;}
      validWindows++;
      const candidate=features.slice(start,i);
      const similarity=score(query,candidate);
      if(similarity>=threshold){
        const previous=candles[i-1]?.close,next=candles[i]?.close;
        matches.push({index:start,time:candles[start]?.time,similarity,
          nextDirection:next==null||previous==null?"UNKNOWN":next>previous?"UP":next<previous?"DOWN":"FLAT"});
      }
    }
    matches.sort((a,b)=>b.similarity-a.similarity);
    return {status:"ready",count:candles.length,patternLength:length,
      threshold:threshold*100,validWindows,skippedGaps,totalMatches:matches.length,
      matches:matches.slice(0,limit)};
  }
  globalThis.PocketCollectorEngine={heikinAshi,vectorize,findSimilar};
})();