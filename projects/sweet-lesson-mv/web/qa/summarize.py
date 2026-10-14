import json,sys,collections
d=json.load(open(sys.argv[1])); top=int(sys.argv[2]) if len(sys.argv)>2 else 25
cnt=collections.Counter(); ex={}
def fld(a,b):
    A=(a or 'MISSING').split('|'); B=(b or 'MISSING').split('|')
    names=['type','name','vis','pos','quat','scale']
    out=[]
    for i in range(max(len(A),len(B))):
        if (A[i] if i<len(A) else None)!=(B[i] if i<len(B) else None): out.append((names[i] if i<6 else 'x%d'%i))
    return ','.join(out)
for r in d['results']:
    for s in r['sample']:
        cnt[s['obj']]+=1; ex.setdefault(s['obj'],(r['T'],fld(s['ref'],s['got'])))
bad=[(r['T'],r['pixDiffBytes']>0,r['stateDiffs']) for r in d['results'] if r['pixDiffBytes'] or r['stateDiffs']]
print('frames',d['frames'],'bad(pixel)',d['bad'],'; Ts with any diff:',len(bad))
print('pixel-bad Ts:',[r['T'] for r in d['results'] if r['pixDiffBytes']])
print('objects differing:',len(cnt))
for o,c in cnt.most_common(top): print(c,o,'e.g. T',ex[o][0],'fields',ex[o][1])
