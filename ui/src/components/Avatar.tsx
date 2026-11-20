/**
 * Shared avatar: the person's photo when there is one, otherwise initials on
 * a stable colour (same hue / initials rules as Sharewall, so a person looks
 * the same everywhere).
 */
import { useEffect, useState } from "react";
import { avatarHue, initials } from "../wall/feed";

export function useBlobUrl(blob: Blob | null | undefined): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!blob) {
      setUrl(undefined);
      return;
    }
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}

export interface AvatarProps {
  name: string;
  /** Stable key for the colour (handle, member label…); defaults to the name. */
  seed?: string;
  photo?: Blob | null;
  /** Ready-made image URL (wins over `photo`). */
  src?: string;
  size?: number;
  agent?: boolean;
  className?: string;
  testId?: string;
}

export function Avatar({ name, seed, photo, src, size = 36, agent, className, testId }: AvatarProps) {
  const blobUrl = useBlobUrl(src ? undefined : photo);
  const url = src ?? blobUrl;
  const style = { width: size, height: size, fontSize: Math.round(size * 0.38) };
  if (url) {
    return <img className={`fy-avatar fy-avatar--photo${className ? ` ${className}` : ""}`} src={url} alt="" aria-hidden="true" style={style} data-testid={testId} draggable={false} />;
  }
  return (
    <span className={`fy-avatar${className ? ` ${className}` : ""}`} aria-hidden="true" data-testid={testId} style={{ ...style, background: `hsl(${avatarHue(seed ?? name)} 38% 33%)` }}>
      {agent ? "🤖" : initials(name)}
    </span>
  );
}
