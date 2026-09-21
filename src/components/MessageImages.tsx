import { theme } from 'antd';
import { useCallback, useEffect, useState } from 'react';

import { ImageLightbox } from './ImageLightbox';
import type { PiImage } from '../shared/protocol';

/**
 * 附件 id = 规范化后字节的 sha256。
 *
 * 会话日志里那张图就是**规范化之后**的字节（服务端在交给 pi 之前先规范化并落盘），
 * 所以在这里对同一份字节取摘要，得到的就是附件库里那个 id —— 不需要服务端再多回传
 * 一个字段，也不会出现「日志里是一份、库里是另一份」的漂移。
 */
async function contentId(image: PiImage): Promise<string | null> {
  try {
    const binary = atob(image.data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `sha256:${hex}`;
  } catch {
    // 非安全上下文没有 SubtleCrypto，或数据不是合法 base64：退回到内联渲染即可。
    return null;
  }
}

/** 内容 id 的进程内缓存：同一张图在历史里出现多次只算一次摘要。 */
const idCache = new Map<string, string | null>();

/**
 * 图片的 src：优先指向附件库，拿不到就退回内联。
 *
 * 走库有三个好处：DOM 里不再为每次渲染带一份 base64；同一个 id 的内容永远不变，浏览器
 * 可以长缓存，历史里重复出现的同一张图只下载一次；重启后图仍在库里，而不是只活在日志
 * 文本里。
 *
 * **一定要有回退**：这条能力之前产生的会话，日志里的图从未落过库，按 id 取会 404。
 * 所以初值是内联地址（保证一定渲染得出来），摘要算出来之后才换成库地址，而库地址
 * 加载失败时再退回内联——老会话因此不会出现裂图。
 */
function useImageSrc(image: PiImage): { src: string; onError: () => void } {
  const inline = `data:${image.mimeType};base64,${image.data}`;
  const [src, setSrc] = useState(inline);

  useEffect(() => {
    let cancelled = false;
    setSrc(`data:${image.mimeType};base64,${image.data}`);
    const cached = idCache.get(image.data);
    if (cached !== undefined) {
      if (cached !== null) setSrc(`/api/attachments/${cached}`);
      return;
    }
    void contentId(image).then((id) => {
      idCache.set(image.data, id);
      if (!cancelled && id !== null) setSrc(`/api/attachments/${id}`);
    });
    return () => {
      cancelled = true;
    };
  }, [image.data, image.mimeType]);

  return { src, onError: () => { setSrc(inline) } };
}

/**
 * The images a message carried or a tool returned.
 *
 * Bounded by CSS: a pasted screenshot must not become a full-width wall, and
 * `loading="lazy"` keeps a long transcript from decoding every image up front.
 * Missing images are not an error — an entry restored from history may know only
 * how many there were.
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
        <StoredImage key={index} image={image} label={`${label} ${index + 1}`} border={token.colorBorderSecondary} />
      ))}
    </div>
  );
}

/** One thumbnail, preferring the durable attachment over the inline copy. */
function StoredImage({
  image,
  label,
  border,
}: {
  image: PiImage;
  label: string;
  border: string;
}) {
  const { src, onError } = useImageSrc(image);
  const [preview, setPreview] = useState(false);
  const close = useCallback(() => setPreview(false), []);
  return (
    <>
    <button type="button" aria-label={`预览${label}`} onClick={() => setPreview(true)} style={{ padding: 0, border: 0, background: 'transparent', cursor: 'zoom-in' }}>
    <img
      src={src}
      alt={label}
      loading="lazy"
      onError={onError}
      style={{
        display: 'block',
        width: 64,
        height: 64,
        borderRadius: 16,
        border: `1px solid ${border}`,
        objectFit: 'cover',
      }}
    />
    </button>
    {preview && <ImageLightbox src={src} alt={label} onClose={close} />}
    </>
  );
}
