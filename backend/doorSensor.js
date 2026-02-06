// doorSensor.js
const { Gpio } = require("pigpio");
const EventEmitter = require("events");

class DoorSensor extends EventEmitter {
  /**
   * @param {object} opts
   * @param {number} opts.pin BCM GPIO number (e.g., 17)
   * @param {number} [opts.glitchFilterUs=5000] debounce/noise filter in microseconds
   * @param {boolean} [opts.useInternalPullup=true] true => PUD_UP, false => PUD_OFF (if you use external pull-up)
   */
  constructor({ pin, glitchFilterUs = 5000, useInternalPullup = true }) {
    super();
    this.pin = pin;
    this.glitchFilterUs = glitchFilterUs;

    this.gpio = new Gpio(pin, {
      mode: Gpio.INPUT,
      pullUpDown: useInternalPullup ? Gpio.PUD_UP : Gpio.PUD_OFF,
      alert: true,
    });

    // Debounce / reject glitches
    this.gpio.glitchFilter(glitchFilterUs);

    // Initial state
    this.level = this.gpio.digitalRead(); // 0/1
    this.emitState("init");

    // Change events
    this.gpio.on("alert", (level, tick) => {
      if (level === this.level) return;
      this.level = level;
      this.emitState("change", tick);
    });
  }

  // With pull-up and switch to GND:
  // level=0 => CLOSED, level=1 => OPEN
  get isOpen() {
    return this.level === 1;
  }

  get state() {
    return {
      ts: Date.now(),
      pin: this.pin,
      level: this.level,
      isOpen: this.isOpen,
    };
  }

  emitState(reason, tick = null) {
    this.emit("state", {
      ...this.state,
      reason,
      tick,
    });
  }

  close() {
    try {
      this.gpio.disableAlert();
    } catch {}
  }
}

module.exports = { DoorSensor };
