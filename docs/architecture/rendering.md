# Rendering

The renderer creates a canonical SVG/HTML representation for preview and artifact generation. `rsvg-convert` renders SVG into PNG, then ImageMagick applies grayscale, monochrome, or posterized palette transforms and also writes a PGM variant for Kindle compatibility experiments.

Render fingerprints include dashboard revision hash, source snapshot hashes, device profile hash, renderer version, font version, and a minute-level time bucket for clock widgets.
