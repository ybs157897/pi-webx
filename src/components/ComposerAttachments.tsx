import { useCallback, useEffect, useRef, useState } from 'react';
import { IconCloseOutline16 } from '../ui/primitives/icons';
import { ImageLightbox } from './ImageLightbox';
import css from './ComposerAttachments.module.css';

export interface DraftImage {
  id: string;
  file: File;
  previewUrl: string;
}

/** Harness's 64px thumbnail rail; originals stay available before sending. */
export function ComposerAttachments({ images, disabled, onRemove }: {
  images: readonly DraftImage[];
  disabled: boolean;
  onRemove: (id: string) => void;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  const rail = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const updateEdges = useCallback(() => {
    const el = rail.current;
    if (el) setEdges({ left: el.scrollLeft > 1, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 });
  }, []);
  useEffect(() => {
    const el = rail.current;
    if (!el) return;
    const observer = new ResizeObserver(updateEdges);
    observer.observe(el);
    updateEdges();
    return () => observer.disconnect();
  }, [images.length, updateEdges]);
  const selected = images.find(image => image.id === preview);
  const close = useCallback(() => setPreview(null), []);
  if (images.length === 0) return null;
  return (
    <div className={css.root}>
      <div className={css.rail} ref={rail} onScroll={updateEdges} aria-label="待发送图片">
        {images.map((image, index) => (
          <div className={css.imageItem} key={image.id}>
            <button type="button" className={css.thumbnail} aria-label={`预览图片 ${index + 1}：${image.file.name}`} onClick={() => setPreview(image.id)}>
              <img src={image.previewUrl} alt={image.file.name} />
            </button>
            <button type="button" className={css.remove} aria-label={`移除图片 ${index + 1}`} disabled={disabled} onClick={() => onRemove(image.id)}>
              <IconCloseOutline16 size={12} />
            </button>
          </div>
        ))}
      </div>
      {edges.left && <button type="button" className={`${css.arrow} ${css.left}`} aria-label="查看前面的图片" onClick={() => rail.current?.scrollBy({ left: -240, behavior: 'smooth' })}>‹</button>}
      {edges.right && <button type="button" className={`${css.arrow} ${css.right}`} aria-label="查看后面的图片" onClick={() => rail.current?.scrollBy({ left: 240, behavior: 'smooth' })}>›</button>}
      {selected && <ImageLightbox src={selected.previewUrl} alt={selected.file.name} onClose={close} />}
    </div>
  );
}
