"""Real Bash confirmation tests. Runs inside the isolated local Challenge."""
import base64,json,os,socket,time,uuid

def attach(generation):
    deadline=time.monotonic()+10
    while True:
        try:
            sock=socket.create_connection(('127.0.0.1',7681),timeout=3)
            break
        except OSError:
            if time.monotonic()>deadline: raise
            time.sleep(.1)
    reader=sock.makefile('rb')
    sock.sendall((json.dumps({'type':'attach','version':1,'mode':'interactive','generation':generation,'columns':80,'rows':24})+'\n').encode())
    assert json.loads(reader.readline())['type']=='ready'
    return sock,reader

def request(sock,reader,value,kind):
    sock.sendall((json.dumps(value)+'\n').encode())
    while True:
        frame=json.loads(reader.readline())
        assert frame['type']!='error',frame
        if frame['type']==kind:return frame

def input(sock,reader,text):
    return request(sock,reader,{'type':'input','generation':1,'data':base64.b64encode(text).decode()},'input_accepted')
def propose(sock,reader,command,token=None):
    token=token or str(uuid.uuid4())
    return request(sock,reader,{'type':'proposal','query':False,'generation':1,'token':token,'proposalId':str(uuid.uuid4()),'command':command},'proposal_receipt'),token

s,r=attach(1)
time.sleep(.2)
# Busy foreground application.
input(s,r,b'sleep 2\n')
value,_=propose(s,r,'touch /tmp/proposal-busy')
assert value['status']=='busy',value
assert not os.path.exists('/tmp/proposal-busy')
time.sleep(2.2)
# Partial Readline input must remain untouched.
input(s,r,b'printf manual')
value,_=propose(s,r,'touch /tmp/proposal-partial')
assert value['status']=='busy',value
assert not os.path.exists('/tmp/proposal-partial')
input(s,r,b'\x15')
# One confirmed command. Repeat the exact delivery frame, with the same identity.
frame={'type':'proposal','query':False,'generation':1,'token':str(uuid.uuid4()),'proposalId':str(uuid.uuid4()),'command':'echo once >> /tmp/proposal-count'}
deadline=time.monotonic()+3
while True:
    value=request(s,r,frame,'proposal_receipt')
    if value['status']!='busy':break
    assert time.monotonic()<deadline,value
    frame['token']=str(uuid.uuid4())
    time.sleep(.05)
assert value['status']=='accepted',value
time.sleep(.1)
value=request(s,r,frame,'proposal_receipt')
assert value['status']=='accepted',value
time.sleep(.1)
assert open('/tmp/proposal-count').read()=='once\n'
# A later distinct proposal works after the first binding returns.
second={**frame,'token':str(uuid.uuid4()),'proposalId':str(uuid.uuid4()),'command':'touch /tmp/proposal-second'}
time.sleep(.1)
value=request(s,r,second,'proposal_receipt')
assert value['status']=='accepted',value
time.sleep(.1)
assert os.path.exists('/tmp/proposal-second')
# Same token with another command cannot execute.
value=request(s,r,{**frame,'command':'touch /tmp/proposal-conflict'},'proposal_receipt')
assert value['status']=='unknown'
assert not os.path.exists('/tmp/proposal-conflict')
print('busy, partial input, confirmed delivery, duplicate and token conflict passed')
