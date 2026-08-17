// Face swap only: same MausAvatar / InitialsAvatar API as OpenMausBot.
// Renders the Rivet den-bot sprite, not the OpenMausBot cursor/Maus mascot.
import { forwardRef, memo, type CSSProperties } from "react";
import denBotUrl from "../assets/den-bot.png";
import { MAUS_COLORS, type MausColor, type MausMotion, type MausState } from "@/lib/mascot";

export const FACE_X = 80;
export const FACE_Y = 102;
export const FACE_SCALE = 0.47;
export const EYE_SCALE = 1.12;
export const MOUTH_WEIGHT = 11;

export type MausAvatarHandle = {
  el: HTMLSpanElement | null;
};

export const MausAvatar = memo(
  forwardRef<
    MausAvatarHandle,
    {
      color: MausColor;
      state?: MausState;
      size?: number;
      motion?: MausMotion;
      motionKey?: number;
      className?: string;
    }
  >(function MausAvatar({ color, size = 56, className }, ref) {
    const hex = MAUS_COLORS[color] ?? MAUS_COLORS.green;
    const style: CSSProperties = {
      width: size,
      height: size,
      boxShadow: `inset 0 0 0 2px ${hex}`,
    };
    return (
      <span
        ref={(el) => {
          if (typeof ref === "function") ref({ el });
          else if (ref) ref.current = { el };
        }}
        className={className}
        style={{
          ...style,
          position: "relative",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: "9999px",
          flexShrink: 0,
        }}
        aria-hidden
      >
        <img
          src={denBotUrl}
          alt=""
          draggable={false}
          style={{
            width: "78%",
            height: "78%",
            objectFit: "contain",
            imageRendering: "pixelated",
          }}
        />
      </span>
    );
  }),
);

export function InitialsAvatar({
  initials,
  size = 36,
  className,
}: {
  initials: string;
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={className}
      style={{
        width: size,
        height: size,
        borderRadius: "9999px",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(16,132,254,0.18)",
        color: "#1084fe",
        fontSize: Math.max(10, size * 0.34),
        fontWeight: 600,
        flexShrink: 0,
      }}
    >
      {initials}
    </span>
  );
}
