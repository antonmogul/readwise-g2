import json, sys, time, urllib.request
B = 'http://127.0.0.1:9898'
OUT = sys.argv[1]
def act(a, wait=0.9):
    req = urllib.request.Request(B + '/api/input', data=json.dumps({'action': a}).encode(), headers={'Content-Type': 'application/json'})
    urllib.request.urlopen(req).read(); time.sleep(wait)
def shot(name):
    with open(f'{OUT}/{name}.png', 'wb') as f: f.write(urllib.request.urlopen(B + '/api/screenshot/glasses').read())
    print('shot', name)
for step in sys.argv[2:]:
    kind, _, arg = step.partition('=')
    if kind == 'shot': shot(arg)
    elif kind == 'sleep': time.sleep(float(arg))
    elif kind == 'hold':
        act('long_press', 0.4); act('long_press_release', 1.5)
    else:
        n = int(arg) if arg else 1
        for _ in range(n): act(kind)
