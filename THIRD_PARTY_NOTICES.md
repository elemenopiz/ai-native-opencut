# Third-Party Notices

Byorn incorporates code and design ideas from the following third-party
projects. Their licenses and copyright notices are reproduced below.

---

## OpenCut (opencut-classic)

- Project: OpenCut-app/opencut-classic
- Homepage: https://github.com/OpenCut-app/opencut-classic
- License: MIT

The cubic-bezier keyframe easing in
`apps/web/src/lib/animation/easing.ts` (presets, the CSS-style timing-function
evaluator, and the surrounding UI patterns for the easing picker) is adapted
from the pure-TypeScript animation math in opencut-classic
(`apps/web/src/animation/bezier.ts`, `graph-channels.ts`, and the
`timeline/components/graph-editor/*` modules). Only the TypeScript animation
math and UI patterns were used; none of the project's Rust/WASM engine code was
copied.

```
MIT License

Copyright 2025-2026 OpenCut

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN
AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
