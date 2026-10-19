import * as React from 'react';

/**
 * True inside a surface that draws a live picture (a shared screen or browser page) under its own
 * controls. That picture is arbitrary pixels — a black terminal under light-theme ink, a white page
 * under dark-theme ink — so a floating surface there (a menu, a popover, a presence capsule) cannot
 * rely on the tint's hair of paint: `GlassSurface` gives it Strong's panel coat at every tint, so a
 * dark picture never turns a light menu into a grey wash of itself.
 * Over the plain page that coat still lands on the floating paint, so nothing else changes.
 */
export const GlassLivePictureBackdropContext = React.createContext(false);
