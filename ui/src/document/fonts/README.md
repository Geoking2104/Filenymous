# Noto Sans (PDF export of the Document editor)

`NotoSans-{Regular,Bold,Italic,BoldItalic}.ttf.gz` are Noto Sans by the Noto
Project Authors, licensed under the SIL Open Font License 1.1 (see `OFL.txt`).
Source: https://github.com/notofonts/notofonts.github.io (`fonts/NotoSans/unhinted/ttf`).

Modified version (allowed by the OFL; the font name is unchanged as these are
not distributed as standalone fonts but embedded in generated PDFs): subset
with fontTools `pyftsubset` to Latin, Latin Extended, IPA, Greek, Cyrillic,
general punctuation, currency, arrows, math operators, geometric shapes and
ligatures; hinting removed; gzip-compressed. They are fetched only when a PDF
is generated in the browser and embedded (subset again) in that PDF.

Regenerate:

    pyftsubset NotoSans-Regular.ttf \
      --unicodes="U+0000-036F,U+0370-03FF,U+0400-052F,U+1E00-1EFF,U+2000-206F,U+20A0-20CF,U+2100-215F,U+2190-21FF,U+2200-22FF,U+2460-24FF,U+25A0-25FF,U+2600-26FF,U+2713-2717,U+FB00-FB06,U+FFFD" \
      --layout-features='kern,liga,clig,ccmp,locl,mark,mkmk' --no-hinting --desubroutinize \
      --output-file=NotoSans-Regular.ttf && gzip -9 NotoSans-Regular.ttf
