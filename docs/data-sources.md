# Data sources

## pexels-junction (default dataset)

A drone hovering high over a T-junction with four painted crosswalks (location not stated on the Pexels page): pedestrians, cyclists, cars, a bus and a garbage truck.

- Source: "Junction in Town" on Pexels, https://www.pexels.com/video/junction-in-town-13905521/
- Author: Lazar Gugleta, https://www.pexels.com/@lazar/
- License: Pexels License, https://www.pexels.com/license/ (free for personal and commercial use; attribution not required but given).
- Credit shown in the viewer: "Video by Lazar Gugleta, Pexels" (`video.credit` in tubes.json).
- Excerpt used: 24 s to 84 s of the 111 s original (2560x1440, 29.97 fps), scaled to 1280x720, 1,798 frames. The drone repositions at 21 to 23 s; from 24 s to 84 s cumulative drift stays under 7 px.

To reproduce:

```sh
mkdir -p data/raw/pexels-13905521 && cd data/raw/pexels-13905521
curl -L -o 13905521.mp4 https://www.pexels.com/download/video/13905521/
ffmpeg -ss 24 -i 13905521.mp4 -t 60 -an -vf scale=1280:-2 -c:v libx264 -crf 20 junction-24s-84s.mp4
cd ../../.. && python -m pipeline.ingest data/raw/pexels-13905521/junction-24s-84s.mp4 --out data/pexels-junction \
  --credit "Video by Lazar Gugleta, Pexels"
```

The crosswalk zone in `zones.json` is the left crosswalk, drawn by hand. Of the four crosswalks it had the most person entries (10) and the only cars stopped inside it.

### Candidates considered for the default

| Candidate | License | Verdict |
| --- | --- | --- |
| Pexels 13905521 "Junction in Town" (Lazar Gugleta) | Pexels | Chosen. High oblique drone view, steady from 24 s, people and moving traffic. |
| Pexels 32024102 "Aerial view of busy Los Angeles intersection" | Pexels | Rejected. YOLO scored 0.0 people and 1.0 moving vehicles per frame over 30 samples. |
| YouTube MNn9qKG2UFI "4K Road traffic video for object detection and tracking" (Karol Majek) | CC BY | Rejected. 7.3 moving vehicles but 0.5 people per frame; close passes in 3% of samples. |
| Pexels 13852105, 15411757 (Novi Sad), 34476224 | Pexels | Rejected after a contact-sheet look; deleted unscored when the brief changed to "pick one". |
| Pexels 39296151, 33585501, 32176499, 32012246, 14457202, 18511664 | Pexels | Rejected from contact sheets: the camera zooms, rotates or pans. |
| Mixkit 61 and 60 (aerial crosswalk, busy intersection) | Mixkit | Not downloaded. Top-down at 720p with very small people. |
| YouTube nomrI8V74Uc (Shibuya rooftop), jbSizKNy6rM | CC BY | Rejected: an edited montage, and an animation. |
| YouTube woZw5hosDOw "Shibuya crossing from above" (Chris S) | CC BY | Rejected: 640x480 from 2011, too small for detection. |

Re-upload channels that tag other people's stock footage CC BY were skipped, because their license is not theirs to give. Pexels, Pixabay and Videvo pages block scripted requests; Pexels clips were reached through its download links.

## astoria-20220723

A fixed webcam looking down a residential street toward an intersection in Astoria, Queens, New York City, recorded on July 23, 2022.

- Source: "July 23, 2022. 24 Hour Webcam Stream of a Street in Astoria, Queens, NYC" on the Internet Archive, https://archive.org/details/july-23-2022-24-hour-webcam-stream-astoria-queens-nyc
- File: `20220723.mp4` (24 hours, 1920x1080, 15 fps, recorded with a WYZE surveillance camera).
- Author: WSBJ.com (uploader mt@wsbj.com).
- License: Creative Commons Attribution-NonCommercial-ShareAlike 4.0, https://creativecommons.org/licenses/by-nc-sa/4.0/
- Excerpt used: 300 seconds starting 57,600 s into the file (on-screen clock 15:58:56 to 16:03:56).

To reproduce the excerpt:

```sh
mkdir -p data/raw/astoria-20220723
ffmpeg -ss 57600 -i https://archive.org/download/july-23-2022-24-hour-webcam-stream-astoria-queens-nyc/20220723.mp4 \
  -t 300 -c copy -an data/raw/astoria-20220723/astoria-1600-5min.mp4
python -m pipeline.ingest data/raw/astoria-20220723/astoria-1600-5min.mp4 --out data/astoria-20220723
```

License terms that apply to us:

- NonCommercial. Use it for the hackathon demo and development only. Swap in the GSU footage before any commercial use.
- ShareAlike. The derived dataset in `data/astoria-20220723/` (re-encoded video, thumbnails, tubes) must be shared, if at all, under CC BY-NC-SA 4.0.
- Attribution. Credit "WSBJ.com, CC BY-NC-SA 4.0" wherever the clip is shown, including the demo video.

## Rejected candidates

These were checked and not used.

- "3 min pedestrian crossing Katella Avenue (Harbor Boulevard) Anaheim" (Wikimedia Commons, CC0). It is a handheld phone shot of a crossing-button sign, not a fixed camera.
- "1 hour Wilhelmshoeher Allee" (Wikimedia Commons, public domain). It is a time-lapse that compresses one hour into 2.5 minutes, with no visible pedestrians.
- "Views of the Caton Farm Road and Essington Road Intersection in Joliet, Illinois" (Commons, CC BY 4.0). It cuts between several camera positions and shows no pedestrians.
- "Tokyo Shibuya Crossing Scramble" (Commons, CC BY 3.0). It is filmed from a moving motorcycle.
- Other Commons and Internet Archive intersection clips with clear licenses are all under 2 minutes.
