import { theme } from 'antd';

import type { PiImage } from '../shared/protocol';

/**
 * The images a message carried or a tool returned.
 *
 * Inline `data:` URLs bounded by CSS: a pasted screenshot must not become a
 * full-width wall, and `loading="lazy"` keeps a long transcript from decoding
 * every image up front. Missing images are not an error — an entry restored
 * from history may know only how many there were.
 */
export function MessageImages({
  images,
  label,
}: {
  images: readonly PiImage[];
  /** Prefix for the alt text, so a screen reader hears what the image belongs to. */
  label: string;
}) {
  const { token } = theme.useToken();
  if (images.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
      {images.map((image, index) => (
        <img
          key={index}
          src={`data:${image.mimeType};base64,${image.data}`}
          alt={`${label} ${index + 1}`}
          loading="lazy"
          style={{
            maxWidth: 180,
            maxHeight: 180,
            borderRadius: 6,
            border: `1px solid ${token.colorBorderSecondary}`,
            objectFit: 'cover',
          }}
        />
      ))}
    </div>
  );
}
