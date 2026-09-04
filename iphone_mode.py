"""iPhone USB mode switch (same vendor requests usbmuxd uses).
usage: python iphone_mode.py get
       python iphone_mode.py set <mode>      mode 3 = CDC-NCM (reverse tethering)
Needs the libusb-win32 filter driver on the iPhone composite device and libusb0.dll next to this file.
Exit codes: 0 ok, 2 device/backend not reachable, 3 switch rejected.
"""
import os, sys, usb.core, usb.util
import usb.backend.libusb0 as libusb0

GET_MODE, SET_MODE = 0x45, 0x52
RT = usb.util.build_request_type(usb.util.CTRL_IN, usb.util.CTRL_TYPE_VENDOR, usb.util.CTRL_RECIPIENT_DEVICE)  # 0xC0
DLL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "libusb0.dll")
def _is_admin():
    try:
        import ctypes; return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return None


def main():
    be = libusb0.get_backend(find_library=lambda _: DLL)
    if be is None:
        print(f"libusb0 backend failed to load: dll={DLL} exists={os.path.exists(DLL)} python={sys.executable}"); sys.exit(2)
    devs = list(usb.core.find(find_all=True, backend=be))
    dev = next((d for d in devs if d.idVendor == 0x05AC), None)
    if dev is None:
        print(f"iPhone not reachable through libusb0 filter: libusb0 sees {len(devs)} device(s) "
              f"[{', '.join(f'{d.idVendor:04x}:{d.idProduct:04x}' for d in devs)}] python={sys.executable} elevated={_is_admin()}"); sys.exit(2)
    cur = dev.ctrl_transfer(RT, GET_MODE, 0, 0, 4, timeout=1000)
    print("GET_MODE " + ":".join(str(b) for b in cur))
    if len(sys.argv) >= 3 and sys.argv[1] == "set":
        mode = int(sys.argv[2])
        r = dev.ctrl_transfer(RT, SET_MODE, 0, mode, 1, timeout=2000)
        ok = len(r) == 1 and r[0] == 0
        print(f"SET_MODE {mode} -> {list(r)} {'accepted' if ok else 'rejected (device not in initial mode?)'}")
        sys.exit(0 if ok else 3)

if __name__ == "__main__":
    main()
