# Optional Linux background bridge. Uses system SDL2/X11 through the Python standard library.
import ctypes as c
import ctypes.util
import json
import os
import queue
import sys
import threading
import time

pid = int(sys.argv[1])
commands = queue.Queue()
def reader():
    for line in sys.stdin:
        commands.put(line.strip())
    commands.put('stop')
threading.Thread(target=reader, daemon=True).start()
os.environ['SDL_JOYSTICK_ALLOW_BACKGROUND_EVENTS'] = '1'
sdl = None
pads = {}
try:
    sdl = c.CDLL(ctypes.util.find_library('SDL2-2.0') or ctypes.util.find_library('SDL2') or 'libSDL2-2.0.so.0')
    sdl.SDL_Init.argtypes = [c.c_uint32]
    sdl.SDL_Init(0x2000)
    sdl.SDL_GameControllerOpen.argtypes = [c.c_int]
    sdl.SDL_GameControllerOpen.restype = c.c_void_p
    for name in ['SDL_GameControllerGetAttached','SDL_GameControllerClose']:
        getattr(sdl,name).argtypes=[c.c_void_p]
    sdl.SDL_GameControllerGetButton.argtypes=[c.c_void_p,c.c_int]
    sdl.SDL_GameControllerGetButton.restype=c.c_uint8
    sdl.SDL_GameControllerGetAxis.argtypes=[c.c_void_p,c.c_int]
    sdl.SDL_GameControllerGetAxis.restype=c.c_int16
except (OSError, AttributeError):
    sdl = None
x11 = None
display = None
try:
    x11 = c.CDLL(ctypes.util.find_library('X11') or 'libX11.so.6')
    x11.XOpenDisplay.argtypes=[c.c_char_p]
    x11.XOpenDisplay.restype=c.c_void_p
    x11.XStringToKeysym.argtypes=[c.c_char_p]
    x11.XStringToKeysym.restype=c.c_ulong
    x11.XKeysymToKeycode.argtypes=[c.c_void_p,c.c_ulong]
    x11.XKeysymToKeycode.restype=c.c_uint8
    x11.XQueryKeymap.argtypes=[c.c_void_p,c.c_void_p]
    display=x11.XOpenDisplay(None)
except (OSError, AttributeError):
    x11=None
pad_keys=[8,9]
key_codes=[]
held=False
await_release=False
mapping=[0,1,2,3,9,10,-1,-1,4,6,7,8,11,12,13,14,5]
def key_down(code, keys):
    name = code[3:].lower() if code.startswith('Key') else code[5:] if code.startswith('Digit') else {'Escape':'Escape','Space':'space','Enter':'Return','ArrowUp':'Up','ArrowDown':'Down','ArrowLeft':'Left','ArrowRight':'Right','ShiftLeft':'Shift_L','ShiftRight':'Shift_R','ControlLeft':'Control_L','ControlRight':'Control_R','AltLeft':'Alt_L','AltRight':'Alt_R','Backspace':'BackSpace'}.get(code,code)
    key=x11.XKeysymToKeycode(display,x11.XStringToKeysym(name.encode()))
    return bool(key and keys[key//8] & (1<<(key%8)))
while os.path.exists('/proc/'+str(pid)):
    while not commands.empty():
        command=commands.get()
        if command=='stop': sys.exit(0)
        if command=='resume': await_release=True
        if command.startswith('{'):
            try:
                config=json.loads(command)
                pad_keys=config['pad']
                key_codes=config['keys']
            except (ValueError,KeyError): pass
    down=False
    if sdl:
        sdl.SDL_PumpEvents()
        for index, pad in list(pads.items()):
            if not sdl.SDL_GameControllerGetAttached(pad):
                sdl.SDL_GameControllerClose(pad)
                del pads[index]
        for index in range(sdl.SDL_NumJoysticks()):
            if index not in pads and sdl.SDL_IsGameController(index):
                pad=sdl.SDL_GameControllerOpen(index)
                if pad: pads[index]=pad
        for pad in pads.values():
            def button(index):
                return sdl.SDL_GameControllerGetAxis(pad,index-2)>16000 if index in (6,7) else bool(sdl.SDL_GameControllerGetButton(pad,mapping[index]))
            down |= all(button(index) for index in pad_keys) or button(16)
    if display:
        keys=(c.c_ubyte*32)()
        x11.XQueryKeymap(display,keys)
        down |= key_down('Escape',keys) or key_down('F10',keys) or (len(key_codes)==2 and all(key_down(code,keys) for code in key_codes))
    if await_release:
        if not down: await_release=False
    elif down and not held: print('home',flush=True)
    held=down
    time.sleep(.03)
