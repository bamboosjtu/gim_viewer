# Third-party runtime resources

The portable distribution includes a Python/PyInstaller runtime, NumPy, py7zr
and its compression libraries, a Node.js executable, Three.js,
three-bvh-csg, three-mesh-bvh, fast-xml-parser, web-ifc and Draco resources.
Direct build versions are recorded in `requirements-build.txt` and
`package-lock.json`; bundled JavaScript dependency versions and license names
are recorded in `_internal/assets/node/dependencies.json`.

JavaScript dependency license files are included beside the compiled Node
engine. Node and Python runtime notices should be retained with their binaries.
If a Blender portable directory is included, retain that directory's license,
copyright and third-party notices when distributing the whole package. Blender
is a separate executable engine; the tool starts it in background mode.

The local compiler source snapshot belongs to this tool. Its initial file
identities are recorded in `snapshot.json`; these files are maintained as an
independent copy and are not loaded from the main application at build or run
time.
