# Championship Logos

Each folder here corresponds to one sport tab on `championships.html`.
The public page bundles the listed files into a single ZIP when an operator
clicks **Download Championship Logos**.

## Folder structure

```
championships/logos/<sport-key>/
  manifest.json          ← lists which files to include in the ZIP
  primary.png            ← actual logo files (any name)
  knockout.png
  ...
```

## Manifest format

```json
{ "files": ["primary.png", "knockout.png", "wordmark.png"] }
```

Only files listed in `manifest.json` are bundled into the ZIP. Files not
listed are ignored. An empty `files` array shows the operator a friendly
"No championship logos uploaded yet" message instead of an empty ZIP.

## Sport keys

| Sport                       | Folder key                  |
| --------------------------- | --------------------------- |
| Cross Country               | `cross-country`             |
| Soccer                      | `soccer`                    |
| Volleyball                  | `volleyball`                |
| Football                    | `football`                  |
| Indoor Track and Field      | `indoor-track-and-field`    |
| Basketball                  | `basketball`                |
| Bowling                     | `bowling`                   |
| Men's Tennis                | `mens-tennis`               |
| Women's Tennis              | `womens-tennis`             |
| Women's Golf                | `womens-golf`               |
| Beach Volleyball            | `beach-volleyball`          |
| Men's Golf                  | `mens-golf`                 |
| Softball                    | `softball`                  |
| Outdoor Track and Field     | `outdoor-track-and-field`   |
| Baseball                    | `baseball`                  |
