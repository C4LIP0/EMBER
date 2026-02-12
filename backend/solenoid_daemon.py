#!/usr/bin/env python3
import sys, json, time, traceback

try:
    import lgpio
except Exception as e:
    print(json.dumps({"type":"fatal","error":f"import lgpio failed: {e}"}), flush=True)
    sys.exit(1)

SHOOT = 23     # BCM
RELEASE = 24   # BCM
ACTIVE_LOW = True  # your MOSFET board (OFF=1, ON=0)

def level_for(on: bool) -> int:
    return 0 if (ACTIVE_LOW and on) else 1 if ACTIVE_LOW else (1 if on else 0)

def read_levels(h):
    return {
        "shoot": lgpio.gpio_read(h, SHOOT),
        "release": lgpio.gpio_read(h, RELEASE),
    }

def safe_all_off(h):
    lgpio.gpio_write(h, SHOOT, level_for(False))
    lgpio.gpio_write(h, RELEASE, level_for(False))

def main():
    h = None
    try:
        h = lgpio.gpiochip_open(0)

        # Claim as outputs + set safe OFF (HIGH for active-low)
        lgpio.gpio_claim_output(h, SHOOT, level_for(False))
        lgpio.gpio_claim_output(h, RELEASE, level_for(False))
        safe_all_off(h)

        print(json.dumps({
            "type":"ready",
            "activeLow": ACTIVE_LOW,
            "pins": {"shoot": SHOOT, "release": RELEASE},
            "levels": read_levels(h)
        }), flush=True)

        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue

            try:
                msg = json.loads(line)
                req_id = msg.get("id")
                cmd = (msg.get("cmd") or "").lower()
                action = (msg.get("action") or "").lower()
                ms = int(msg.get("ms") or 0)

                # Safety: never allow both ON
                def set_shoot(on):
                    if on:
                        lgpio.gpio_write(h, RELEASE, level_for(False))
                    lgpio.gpio_write(h, SHOOT, level_for(on))

                def set_release(on):
                    if on:
                        lgpio.gpio_write(h, SHOOT, level_for(False))
                    lgpio.gpio_write(h, RELEASE, level_for(on))

                if cmd == "status":
                    out = {"ok": True}

                elif cmd == "alloff":
                    safe_all_off(h)
                    out = {"ok": True}

                elif cmd == "shoot":
                    if action == "set":
                        set_shoot(bool(msg.get("on")))
                        out = {"ok": True}
                    elif action == "pulse":
                        if ms <= 0: ms = 200
                        set_shoot(True)
                        time.sleep(ms / 1000.0)
                        set_shoot(False)
                        out = {"ok": True}
                    else:
                        out = {"ok": False, "error": "shoot requires action=set|pulse"}

                elif cmd == "release":
                    if action == "set":
                        set_release(bool(msg.get("on")))
                        out = {"ok": True}
                    elif action == "pulse":
                        if ms <= 0: ms = 500
                        set_release(True)
                        time.sleep(ms / 1000.0)
                        set_release(False)
                        out = {"ok": True}
                    else:
                        out = {"ok": False, "error": "release requires action=set|pulse"}

                else:
                    out = {"ok": False, "error": f"unknown cmd: {cmd}"}

                resp = {
                    "type": "resp",
                    "id": req_id,
                    **out,
                    "activeLow": ACTIVE_LOW,
                    "pins": {"shoot": SHOOT, "release": RELEASE},
                    "levels": read_levels(h),
                }
                print(json.dumps(resp), flush=True)

            except Exception as e:
                resp = {
                    "type": "resp",
                    "id": msg.get("id") if isinstance(msg, dict) else None,
                    "ok": False,
                    "error": str(e),
                    "trace": traceback.format_exc(),
                }
                print(json.dumps(resp), flush=True)

    finally:
        try:
            if h is not None:
                safe_all_off(h)
                lgpio.gpiochip_close(h)
        except Exception:
            pass

if __name__ == "__main__":
    main()

