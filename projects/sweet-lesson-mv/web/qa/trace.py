import json,sys,math
def analyze(tr, label):
    # tr rows: now(ms),T,px,py,pz,qx,qy,qz,qw,f,e
    out=[]; 
    for a,b in zip(tr,tr[1:]):
        dt=(b[0]-a[0])/1000.0
        if dt<=0 or dt>0.2: continue
        dp=math.dist(a[2:5],b[2:5])
        dot=abs(sum(x*y for x,y in zip(a[5:9],b[5:9]))); ang=2*math.acos(min(1,dot))*180/math.pi
        out.append((b[1],dp/dt,ang/dt,b[9],b[10]))
    return out
