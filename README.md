# gifsonic

A little Linux app for turning videos into GIFs. It looks like a terminal
program, but you can do everything with the mouse too.

![gifsonic](docs/screenshot.png)

## What it does

Open a video, pick the part you want, and press <kbd>e</kbd> to make the GIF.

You can drag the start and end handles on the timeline, or type exact times
like `12.5` or `1:02.5`. <kbd>&lt;</kbd> and <kbd>&gt;</kbd> step one frame
at a time. Frame rate goes from 5 to 50 fps, and the width can be 100, 160,
260, 320, 360, 480, 640 or 800 px, or anything you type in. Crop by dragging
on the preview, either freely or locked to 1:1, 4:3, 16:9 or 9:16.

You can put text and images on top. Drag them to move, resize or rotate them
(the keyboard works too), trim their edges, and change opacity or stacking
order. Text gets a font, bold/italic, alignment, colour, an outline and an
optional background box. Each layer can show for only part of the GIF, with a
fade in or out if you want one.

Clicking a text or image in the preview switches the timeline and crop over
to that item, so the handles set when it shows up and crop trims the item
itself. Click empty space or press <kbd>g</kbd> to go back to the GIF. You
can also slide a whole span along the timeline by dragging its top edge.

GIFs come out small. gifsonic has its own encoder with a shared palette,
optional dithering, and it only stores the pixels that change between frames.
Everything stays on your computer, and if you try to close it before saving a
GIF, it asks first.

## Install

You need Python 3. `ffmpeg` is optional but worth having, since it lets
gifsonic open formats like MKV, MOV and HEVC.

```sh
git clone https://github.com/wagidevnull/gifsonic.git
cd gifsonic
./install.sh
```

No root needed. The installer adds gifsonic to your app menu, gives you a
`gifsonic` command, and offers to install the window packages it needs
(pywebview and WebKitGTK) using your package manager.

```sh
gifsonic              # open the app
gifsonic clip.mp4     # open a video straight away
```

You can also right-click a video in your file manager and pick *Open with
gifsonic*. GIFs go to `~/Pictures/gifsonic`, or wherever `GIFSONIC_SAVE_DIR`
points.

To update, run `git pull && ./install.sh`. To remove it, run
`./install.sh --uninstall`.

## Keyboard

Press <kbd>?</kbd> in the app to see these.

| Key | Action |
|---|---|
| <kbd>space</kbd> | play / pause the selection |
| <kbd>&lt;</kbd> <kbd>&gt;</kbd> (or <kbd>,</kbd> <kbd>.</kbd>) | step one GIF frame |
| <kbd>j</kbd> <kbd>l</kbd> | step one second |
| <kbd>i</kbd> / <kbd>o</kbd> | set start / end at the playhead |
| <kbd>g</kbd> | switch between editing the gif and the selected item |
| <kbd>{</kbd> <kbd>}</kbd> | slide the span being edited by one frame |
| <kbd>c</kbd> | crop the gif, or the selected item |
| <kbd>t</kbd> / <kbd>p</kbd> | add text / image layer (you can also drop or paste images) |
| <kbd>tab</kbd> | select next layer |
| arrows | nudge layer (<kbd>shift</kbd> = 10 px) |
| <kbd>+</kbd> <kbd>-</kbd> / <kbd>r</kbd> <kbd>R</kbd> | resize / rotate layer |
| <kbd>del</kbd> | delete layer |
| <kbd>e</kbd> | make the GIF |

## License

MIT, see [LICENSE](LICENSE).
