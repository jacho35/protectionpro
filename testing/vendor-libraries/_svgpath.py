import re, math
def parse(svgfile):
    s=open(svgfile).read()
    body=s[s.find('</defs>'):]
    out=[]
    for m in re.finditer(r'<path\b([^>]*)>', body):
        a=m.group(1)
        d=re.search(r' d="([^"]*)"',a)
        if not d: continue
        st=re.search(r'style="([^"]*)"',a); st=st.group(1) if st else ''
        tr=re.search(r'transform="matrix\(([^)]*)\)"',a)
        M=[1,0,0,1,0,0]
        if tr: M=[float(x) for x in tr.group(1).split(',')]
        toks=re.findall(r'[MLCZ]|-?\d+\.?\d*(?:e-?\d+)?', d.group(1))
        polys=[];cur=[];i=0;last=None;cmd=None
        def T(x,y): return (M[0]*x+M[2]*y+M[4], M[1]*x+M[3]*y+M[5])
        while i<len(toks):
            t=toks[i]
            if t in 'MLCZ': cmd=t; i+=1
            if cmd=='M':
                if cur: polys.append(cur)
                x,y=float(toks[i]),float(toks[i+1]); i+=2; cur=[T(x,y)]; last=(x,y); cmd='L'
            elif cmd=='L':
                x,y=float(toks[i]),float(toks[i+1]); i+=2; cur.append(T(x,y)); last=(x,y)
            elif cmd=='C':
                x1,y1,x2,y2,x,y=[float(v) for v in toks[i:i+6]]; i+=6
                x0,y0=last
                for k in range(1,9):
                    u=k/8
                    bx=(1-u)**3*x0+3*(1-u)**2*u*x1+3*(1-u)*u*u*x2+u**3*x
                    by=(1-u)**3*y0+3*(1-u)**2*u*y1+3*(1-u)*u*u*y2+u**3*y
                    cur.append(T(bx,by))
                last=(x,y)
            elif cmd=='Z':
                if cur: cur.append(cur[0]); polys.append(cur); cur=[]
                cmd=None
        if cur: polys.append(cur)
        out.append((st,polys))
    return out
