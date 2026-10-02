import json,sys,os
from PIL import Image, ImageDraw
root=os.path.dirname(os.path.abspath(__file__))+'/../review/m1/shots/'
def sheet(dirs, out, cols=4, W=720):
    items=[]
    for d in dirs:
        meta=json.load(open(root+d+'/meta.json'))
        for i,m in enumerate(meta): items.append((d,i,m))
    H=int(W*9/16); rows=(len(items)+cols-1)//cols
    S=Image.new('RGB',(W*cols,H*rows),(0,0,0))
    for k,(d,i,m) in enumerate(items):
        im=Image.open(f'{root}{d}/{i+1:02d}.jpg').convert('RGB').resize((W,H))
        dr=ImageDraw.Draw(im); st=m['st']
        dr.rectangle((0,0,W,34),fill=(0,0,0)); dr.text((8,4),f"{d}  T={m['T']:.1f}  {m['label']}",fill=(255,255,0))
        dr.text((8,18),f"{st['ctx']} {st.get('mode','')} f={st['f']:.2f} e={st['e']:.2f}  pos=({st['pos'][0]:.1f},{st['pos'][1]:.1f},{st['pos'][2]:.1f})",fill=(160,255,160))
        S.paste(im,((k%cols)*W,(k//cols)*H))
    S.save(root+'../'+out,quality=88); print(out,S.size)
if __name__=='__main__':
    sheet(['room-walk-night'],'sheet-room-night.jpg',cols=4)
    sheet(['room-overhead-drop'],'sheet-room-overhead.jpg')
    sheet(['room-dawn'],'sheet-room-dawn.jpg')
    sheet(['white-walk'],'sheet-white.jpg')
    sheet(['forced-boundary-free','forced-boundary-flow'],'sheet-forced-boundary.jpg',cols=6,W=480)
