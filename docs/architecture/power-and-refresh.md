# Power and Refresh

Connector collection, dashboard rendering, device polling, and physical panel refresh are separate. This lets the server preserve power by returning `304 Not Modified` and lets a Kindle skip redraws when the image hash has not changed.

The scheduler chooses the next useful poll from source validity, playlist boundaries, clock-widget boundaries, quiet-hour boundaries, and configured min/max intervals.
