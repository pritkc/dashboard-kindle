# Rendering

The renderer creates a canonical SVG/HTML representation for preview and artifact generation. ImageMagick converts SVG into grayscale, monochrome, or posterized PNG output and also writes a PGM variant for Kindle compatibility experiments.

Render fingerprints include dashboard revision hash, source snapshot hashes, device profile hash, renderer version, font version, and a minute-level time bucket for clock widgets.
