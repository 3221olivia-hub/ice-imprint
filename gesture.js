/* Geometry uses camera-width units, independent of video resolution. */
(() => {
  const clamp = (x, low=0, high=1) => Math.max(low, Math.min(high, x));
  function measure(points, aspect) {
    const point = i => ({x:1-points[i].x, y:points[i].y*aspect});
    const distance = (a,b) => Math.hypot(a.x-b.x,a.y-b.y);
    const thumb=point(4), index=point(8), wrist=point(0), middle=point(9);
    const size=Math.max(distance(point(5),point(17)),distance(wrist,middle)*.75,.015);
    return {grip:{x:(thumb.x+index.x)/2,y:(thumb.y+index.y)/2}, size,
      pinch:distance(thumb,index)/size};
  }
  class Tracker {
    constructor(){this.reset();}
    reset(waitOpen=false){this.session=null;this.candidate=null;this.missingSince=null;this.waitOpen=waitOpen;}
    update(landmarks, width, height, now) {
      const aspect=height/width;
      const hands=landmarks.filter(p=>p.length===21&&p.every(v=>Number.isFinite(v.x)&&Number.isFinite(v.y)))
        .slice(0,2).map(p=>measure(p,aspect)).sort((a,b)=>a.grip.x-b.grip.x);
      const pair=hands.length===2;
      const holding=pair&&hands.every(h=>h.pinch<(this.session ? .48 : .32));
      if(this.waitOpen){if(!holding)this.waitOpen=false;return {type:'idle',hands};}
      if(!holding){
        this.candidate=null;
        if(this.session){
          this.missingSince??=now;
          // Brief occlusion freezes the gesture rather than releasing a tear.
          if(now-this.missingSince>(pair?100:350)){this.session=null;this.missingSince=null;return {type:'end',hands};}
          return {type:'hold',hands};
        }
        return {type:'idle',hands};
      }
      this.missingSince=null;
      const [a,b]=hands, span=Math.hypot(b.grip.x-a.grip.x,b.grip.y-a.grip.y);
      if(!this.session){
        if(!this.candidate){this.candidate={since:now};return {type:'idle',hands};}
        if(now-this.candidate.since<90)return {type:'idle',hands};
        this.session={span,range:clamp((a.size+b.size)*1.6,.18,.48)};
        this.candidate=null;
        return {type:'start',hands,aspect,progress:0};
      }
      // Moving both hands together does not advance the tear; separation does.
      return {type:'move',hands,aspect,progress:clamp((span-this.session.span-.008)/this.session.range)};
    }
  }
  globalThis.IceGesture={Tracker,measure,clamp};
})();
