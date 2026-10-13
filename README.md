# Fraudible Cast receiver

Custom Google Cast Web Receiver for [Fraudible](https://github.com/marceljhuber), a personal Audiobookshelf client.
Shows a cover-tinted now-playing screen (cover, title, chapter X of Y, progress, speed) and a TV-sized read-along view.

The phone sends book details, the cover and read-along text over the custom namespace
`urn:x-cast:dev.marcelhuber.fraudible`; this page holds no library data or credentials.
Open `index.html?demo=1` (add `&read=1` for the read-along view) in a desktop browser to preview it.
