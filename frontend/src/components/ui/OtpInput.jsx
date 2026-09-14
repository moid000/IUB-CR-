import { useEffect, useRef } from 'react';

/**
 * Six-segment OTP input with paste support, auto-advance and backspace nav.
 * The code exists ONLY in component state — never persisted anywhere.
 */
export function OtpInput({ value, onChange, disabled = false, invalid = false, autoFocus = true }) {
  const refs = useRef([]);
  const digits = Array.from({ length: 6 }, (_, i) => value[i] ?? '');

  useEffect(() => {
    if (autoFocus && !disabled) refs.current[0]?.focus();
  }, [autoFocus, disabled]);

  const setDigit = (idx, d) => {
    const next = value.split('');
    next[idx] = d;
    onChange(next.join('').slice(0, 6));
  };

  const handleChange = (idx, raw) => {
    const digitsOnly = raw.replace(/\D/g, '');
    if (digitsOnly.length > 1) {
      // paste into remaining boxes
      const next = value.split('');
      for (let i = 0; i < digitsOnly.length && idx + i < 6; i++) next[idx + i] = digitsOnly[i];
      onChange(next.join('').slice(0, 6));
      refs.current[Math.min(idx + digitsOnly.length, 5)]?.focus();
      return;
    }
    setDigit(idx, digitsOnly);
    if (digitsOnly && idx < 5) refs.current[idx + 1]?.focus();
  };

  const handleKeyDown = (idx, e) => {
    if (e.key === 'Backspace' && !digits[idx] && idx > 0) {
      refs.current[idx - 1]?.focus();
    } else if (e.key === 'ArrowLeft' && idx > 0) {
      refs.current[idx - 1]?.focus();
    } else if (e.key === 'ArrowRight' && idx < 5) {
      refs.current[idx + 1]?.focus();
    }
  };

  return (
    <div
      className="flex justify-between gap-2"
      role="group"
      aria-label="6-digit verification code"
    >
      {digits.map((d, idx) => (
        <input
          key={idx}
          ref={(el) => { refs.current[idx] = el; }}
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={1}
          value={d}
          disabled={disabled}
          aria-label={`Digit ${idx + 1}`}
          onChange={(e) => handleChange(idx, e.target.value)}
          onKeyDown={(e) => handleKeyDown(idx, e)}
          onPaste={(e) => { e.preventDefault(); handleChange(idx, e.clipboardData.getData('text')); }}
          className={`h-12 w-11 rounded-xl border text-center text-lg font-semibold text-slate-900 transition-colors
            sm:h-14 sm:w-12
            ${invalid ? 'border-red-400 bg-red-50/40' : 'border-slate-200 bg-white hover:border-slate-300 focus:border-primary-500'}
            disabled:cursor-not-allowed disabled:opacity-50`}
        />
      ))}
    </div>
  );
}
