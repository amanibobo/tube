## Inspiration

Cameras record millions of hours of video every day, and almost nobody watches it. Traffic cameras, dashcams, game film, wildlife cams: when something happens, a person sits down and scrubs through it by hand.

Video is a hard thing to search. A search box can find a file name or a caption, but it can't find "the moment a pedestrian and a car came too close" or "every time a car stopped in the crosswalk". Those are questions about how things moved over time, and a list of frames doesn't show that.

For traffic safety this costs lives. Dangerous intersections are usually found from crash reports, after someone is hurt. Near misses happen far more often than crashes and predict where crashes will happen, but finding them means watching hours of footage that nobody has time to watch.

I wanted to see time the way you see space. Stack the frames of a fixed-camera video into a block, with x, y, and time going back. Every object that moves through the scene then becomes a tube. A tube's slant is its speed, a straight run means it stopped, and two tubes coming close means two things got close. Questions about time become questions about shape, which code can answer exactly.

That's Tube.

## What it does

Tube turns a video into a 3D space-time cube you can search by what happened. Traffic is the first use case.

**The cube.** Open a clip and the video folds back into a cube. Drag the frame plane through time, or play the video at 1x to 8x, and the plane follows it. Before you search, you see a smoky block of the footage. Type `car` or `person`, or say it into the mic, and only those tubes appear, each one a stack of outlines through time.

**Ask in plain English.** Ask "every time a person and a car got close" and the close passes glow red in the cube, with a ranked list beside it. Click the top result and the plane and video jump to that moment. Other questions work too, like "top 3 most dangerous moments", "which cars stopped in the crosswalk" or "fastest car in the clip". Every answer is a set of track IDs and frame ranges you can check by scrubbing to them.

**Upload your own video.** Drop in a fixed-camera clip of up to two minutes. Within a few seconds the video and the cube's volume appear, and the tubes fill in live as the GPUs finish each chunk. With warm GPUs, a one-minute clip is ready in about 50 seconds.

**Search a whole archive.** Archive search draws 12 clips (37 minutes, 4,442 frames) as filmstrips laid out in 3D. Search by meaning, like "cyclist" or "a bus turning", and every matching moment lights up across every clip at once, ranked. Click a moment to pin it and read its full caption. Then send it to the cube: Tube cuts 20 seconds either side of that moment out of the archive video and builds the space-time view just for that window. Searching everything is cheap, so the expensive, detailed view only runs where it matters.

## How I built it

Tube is a React and three.js web app, a Python FastAPI server, and a segmentation pipeline that runs on Modal GPUs.

**Prepare →** ffmpeg normalizes the upload to at most 1280x720 and two minutes, and cuts thumbnails right away, so the cube and frame plane show up before tracking finishes.

**Segment →** SAM 3 finds vehicles, people and bicycles from text prompts and tracks them through the video. To make it fast, I sample at 6 fps, split the clip into chunks, and run the chunks on several GPUs at once on Modal. Then I stitch the tracks back together where the chunks overlap by matching masks, and fill the skipped frames by moving each outline along its path. If Modal is unreachable, YOLO11-seg with ByteTrack runs on the laptop instead and writes the same files.

**Build tubes →** OpenCV turns each mask into a simplified contour per frame. pandas and shapely compute speed, ground position and close passes. Distances run from a person's feet to the ground line of the vehicle, not between centers, and frames where a person is mostly hidden behind a vehicle are skipped. Thresholds scale with the median person height in the clip, so "close" means the same thing in a drone shot and a street camera.

**Ask →** Claude Sonnet 5.5 never sees a contour. It plans calls to geometry tools: `near`, `stopped`, `in_zone`, `filter_tracks`, `rank_near_misses` and `count`. It ends every answer with one `highlight` call that names track IDs, so the cube can only light up things the tools actually found. The demo questions are cached, so the demo runs with Wi-Fi off.

**The viewer →** React with react-three-fiber. Each track is one merged line geometry, so search only changes opacity and never rebuilds anything, and the cube holds 60 fps with thousands of frames. The faint video volume is a raymarched 3D texture built from 96 frames. Job progress streams over server-sent events, so new tubes fade in as each chunk lands. Voice search streams the microphone to ElevenLabs' realtime speech-to-text.

**Archive search →** The archive is my vidsearch engine, merged in as its own page. It splits each clip into shots with PySceneDetect and embeds frames and three-second windows with SigLIP 2. Claude captions each shot, and those captions are embedded with bge. Search fuses all three rankings with reciprocal rank fusion, and the media is served from Cloudflare R2. "Send to the cube" calls a new route that range-reads just the 40-second window straight from R2 with ffmpeg, then runs the same job as an upload.

**The hosted demo →** tube-kohl.vercel.app is a static build. A script snapshots one clip's tubes, frames and cached answers, so judges can use the cube without a server or GPU behind it. The landing page draws the cube itself in animated ink dashes on a canvas.

## Challenges I ran into

**The camera angle lied about distance.** My first ranking on real footage put a pedestrian zero pixels from a bus. From a high angle, the bus roof covered the person in the image, while on the ground they were meters apart. I stopped measuring between centers and started measuring from a person's feet to the bottom edge of the vehicle, and skipped frames where one mask mostly covers the other. The false near misses went away, and a real pass at the curb rose to the top.

**Real footage is messy.** A no-parking sign was detected as a person. Cyclists were paired with their own bikes because YOLO labeled the bikes "motorcycle". SAM 3's "car" prompt missed the bus and the garbage truck. Each fix was small: a "vehicle" prompt that catches all three, dropping tracks that never move or last under a second, and removing a vehicle track that sits mostly inside a person's mask. Finding them meant drawing every result back onto the real frames.

**Making SAM 3 fast enough to feel interactive.** My first runs took about two minutes for a one-minute clip. Profiling showed the cost was in frames and in the number of chunks, not in uploading the video. Sampling at 6 fps, matching the chunk count to the GPU count, and reusing one video session across prompts brought it to 48.7 seconds warm.

**Idle GPUs ran up the bill.** In one day, Modal billed $23 for H100 time. Only about a third of it was real work. The rest was GPUs waiting out a five-minute idle window, plus a warm-up ping I fired every time the app opened. Partway through, Modal disabled the workspace. I cut the idle window to 60 seconds, warmed the GPU only when a file is picked, and benchmarked L4s against H100s. The L4s were about 3.5 times slower for about 10% less per clip, so the real savings were in idle time.

**Merging two apps without breaking either.** Both apps styled the same class names globally. I split the stylesheets by route and loaded each page lazily, so the cube and the archive never load each other's CSS or keyboard shortcuts.

## Accomplishments that I'm proud of

- A full path from an uploaded video to a searchable space-time cube in about a minute, with tubes streaming in while it works.
- Answers you can check: the language model picks tools and phrases the result, but every highlight comes from geometry, not prose.
- Two products made into one app: search a whole archive by meaning, then send one moment to the cube for exact measurement.
- A hosted demo judges can open without a server, a GPU or an API key behind it.
- 53 tests covering the geometry, the upload and clip jobs, and chunk stitching, plus browser scripts that drive the real app.

## What I learned

- In video, pixel distance means nothing until you account for the camera. Where something touches the ground matters more than where its center is.
- Let the model plan and let code measure. Once the language model could only point at results the tools found, it stopped making things up.
- On GPUs, idle time is the bill. The cheapest optimization was turning things off, not buying smaller hardware.
- Look at the real frames. Every metric looked fine until I drew the results onto the video.

## What's next for Tube

- **Tell it what to track.** SAM 3 already takes text prompts, so the next step is a box at upload: "dog", "player", "ball". That opens up sports film, animal behavior and wildlife cameras, where a coach or a researcher can ask "who covered the most ground" or "when did the two dogs get closest".
- **Speed coloring.** Color each tube by how fast it moves, so sprints, braking and sudden stops stand out without a single query.
- **Real units.** A four-point ground calibration turns pixels into meters and pixels per second into miles per hour, and enables post-encroachment time, the measure safety engineers actually use.
- **Live cameras.** Stream a camera into a rolling cube and flag near misses as they happen, instead of after the fact.
