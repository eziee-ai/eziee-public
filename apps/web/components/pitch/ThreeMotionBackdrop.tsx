"use client";

import { StreamConvergenceBackground } from "@designcodeio/threeui";
import s from "./pitch.module.css";

/** ThreeUI supplies the animated field; the pitch copy and anime operator stay in the foreground. */
export function ThreeMotionBackdrop({ theme }: { theme: "light" | "dark" }) {
  const dark = theme === "dark";

  return (
    <div className={`${s.motionBackdrop} ${dark ? s.motionBackdropDark : s.motionBackdropLight}`} aria-hidden="true">
      <StreamConvergenceBackground
        speed={dark ? 0.7 : 0.45}
        fidelity={dark ? 0.72 : 0.58}
        scale={dark ? 1.15 : 1.08}
        brightness={dark ? 0.5 : 0.78}
        opacity={dark ? 0.48 : 0.26}
        hue={dark ? 68 : 192}
        saturation={dark ? 1.55 : 1.15}
      />
    </div>
  );
}
