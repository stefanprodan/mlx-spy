// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

export type Size = { width: number; height: number };

export const MAX_ZOOM = 4;
export const MIN_ZOOM = 0.1;
export const ZOOM_STEP = 0.25;

// Zero dimensions are the first render, before the image or viewport loads.
export function diagramScale(image: Size, viewport: Size, zoom: number | null) {
  if (
    image.width <= 0 ||
    image.height <= 0 ||
    viewport.width <= 0 ||
    viewport.height <= 0
  )
    return 0;
  return (
    zoom ??
    Math.min(
      MAX_ZOOM,
      viewport.width / image.width,
      viewport.height / image.height,
    )
  );
}
