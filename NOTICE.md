# Notices

RisuBard incorporates inherited GPLv3 code derived from RisuAI. Applicable original notices, copyright statements, repository history, and license terms remain preserved.

RisuBard changes and independently authored code:

Copyright (C) 2026 rpaddict

The repository is distributed under the GNU General Public License, version 3. See `LICENSE`.

## Third-party icons

The workspace mode switch, character configuration navigation, and lorebook workspace use Solar Icons in the Bold style,
created by [480 Design](https://www.figma.com/community/file/1166831539721848736).
The icons are licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
Their fill color and Svelte wrapper were adapted for RisuBard theming.

## Bundled display fonts

KaTeX 0.16.27 CSS and code use the MIT license in `public/fonts/KaTeX-LICENSE.txt`.
The unchanged KaTeX font files carry SIL Open Font License 1.1 notices; their
embedded copyright and reserved names, plus the license, are copied to
`public/fonts/KaTeX-Fonts-OFL.txt`. The web build keeps these fonts in `dist/assets/`
as files or as embedded data in the stylesheet.
Tilt Prism and Yellowtail are bundled unchanged under their licenses in
`public/fonts/interface/`; `SOURCES.json` records the original URLs and hashes.

## Optional Android local AI engine

The Offline build includes llama.cpp at commit
`ea0c4c2c85fb183ec0fbd30a1af4e4275a18a064` (MIT), built with Android NDK r29.
Its entry point is replaced by `scripts/android/llama-owner-main.cpp` to stop
the child if its RisuBard server dies. The engine, included vendor libraries,
and NDK runtime notices are preserved in `android-app/notices/llama.cpp/` and
included in the packaged runtime. Model weights are selected by the user and
are not included in the APK; their own licenses apply.
