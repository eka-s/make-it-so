import { avatarHue, avatarInitial } from "./avatar";

type CrewIconProps = {
  /** Display name (the source of the initial and color when there is no icon). */
  name: string;
  /**
   * URL of the configured icon image (`icon` of GET /api/crew). If none, the avatar built from the name is shown.
   */
  iconUrl?: string;
  size?: number;
};

// A crew member's icon. Shows the image if one is set, otherwise the avatar built from the name (initial + color).
// The image is uploaded by the user from the screen (the crew profile, CrewProfilePopup.tsx).
export function CrewIcon({ name, iconUrl, size = 22 }: CrewIconProps) {
  if (iconUrl) {
    return <img className="crew-icon" src={iconUrl} width={size} height={size} alt="" aria-hidden="true" style={{ borderRadius: 4, objectFit: "cover" }} />;
  }
  const hue = avatarHue(name);
  return (
    <svg className="crew-icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect width="24" height="24" rx="4" fill={`hsl(${hue} 45% 32%)`} />
      <text x="12" y="12" textAnchor="middle" dominantBaseline="central" fontSize="13" fontWeight="700" fill={`hsl(${hue} 80% 88%)`} fontFamily="sans-serif">
        {avatarInitial(name)}
      </text>
    </svg>
  );
}
