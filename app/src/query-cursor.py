import ctypes

x11 = ctypes.CDLL("libX11.so.6")
x11.XOpenDisplay.restype = ctypes.c_void_p
dpy = x11.XOpenDisplay(None)
if not dpy:
    raise SystemExit(1)

root = x11.XDefaultRootWindow(dpy)
root_return = ctypes.c_ulong()
child_return = ctypes.c_ulong()
root_x = ctypes.c_int()
root_y = ctypes.c_int()
win_x = ctypes.c_int()
win_y = ctypes.c_int()
mask = ctypes.c_uint()

x11.XQueryPointer(
    ctypes.c_void_p(dpy), ctypes.c_ulong(root),
    ctypes.byref(root_return), ctypes.byref(child_return),
    ctypes.byref(root_x), ctypes.byref(root_y),
    ctypes.byref(win_x), ctypes.byref(win_y),
    ctypes.byref(mask),
)

print(f"{root_x.value},{root_y.value}")
