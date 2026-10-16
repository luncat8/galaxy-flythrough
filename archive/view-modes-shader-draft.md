separate render html

constellations, similar as Sun, H in main project

then make few view modes radio buttons:

1. distance from camera to star as heightmap
fill all sphere with color shat show distance to these main stars:
0...1 far to closest
think how better show - it should looks like heightmap, smooth. i know only diffusion algorithm may give good result, but maybe you found some faster.

2. distance between adjacent stars as heightmap.
i mean some stars visually are close but in 3d has big Z distance. i want to visualize this as similar smooth heightmap for game purpose: height gradient on this map mean slow travel, so for example we can pass 2d map to pathfinding algorithm in some specific game mode. or apply it to visual star ship movement


good if this can be updated realtime while stars move (star time slider).

to apply this to constellations or to nearest N stars (slider, default 0 = constellations, max 500 if this is not slow)

make it somewhat separate from main code so this part will not confuse or take context of main development agents

- **Projection**: default is 3D (inside view sphere). possible also projection on plane - see https://github.com/luncat8/planet-geotectonics how projection made and drag pan implemented.