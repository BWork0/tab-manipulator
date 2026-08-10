# Tab Manipulator release metadata

This document is the source of truth for the first production store listings. Store credentials and recovery details must remain outside the repository.

## Product identity

- **Name:** Tab Manipulator
- **Version:** 1.0.0
- **Description:** Rotate selected tabs automatically and refresh them on a schedule, with all data kept on your device.
- **Icon:** The green linked-tab artwork in `public/icon/` is the approved production icon set.

## Browser metadata

| Store                  | Minimum browser | Publisher owner | Stable extension ID                |
| ---------------------- | --------------- | --------------- | ---------------------------------- |
| Chrome Web Store       | Chrome 120      | BWork0          | Assigned by the store              |
| Microsoft Edge Add-ons | Edge 120        | BWork0          | Assigned by the store              |
| Firefox Add-ons        | Firefox 140     | BWork0          | `tab-manipulator@bwork0.github.io` |

Chrome and Edge 120 are the minimum Chromium versions because version 120 introduced 30-second extension alarms. Firefox 140 is the supported ESR baseline for the first release. The T063 beta matrix certified the production builds on Chrome 151.0.7922.76, Edge 151.0.4129.72, and Firefox 153.0.3.

## Production defaults

New installations default to 30-second rotation and 5-minute refresh. The beta matrix observed successful 10-second and 30-second rotation ticks in every required browser, but only intervals of 30 seconds or longer use reliable background alarms. The 10-second preset remains available as an explicitly labelled best-effort option.

## Launch sequence

1. Publish to the Chrome Web Store under BWork0 ownership.
2. After the Chrome listing is accepted, install its store build in a fresh profile and complete a smoke test. Then publish the same Chromium release to Microsoft Edge Add-ons under BWork0 ownership.
3. After the Edge listing is accepted and smoke-tested, publish the Firefox MV3 release to Firefox Add-ons under BWork0 ownership.

Store-assigned listing IDs may be recorded after submission; they are not source manifest metadata and do not replace the stable Firefox extension ID.
