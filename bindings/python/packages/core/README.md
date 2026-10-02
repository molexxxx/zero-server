# zero-server-core

The zero-server core's surface for Python: the runtime version of the compiled core. This is the counterpart of the `zero-core` crate, and like it, it is small. The compiled core it loads is `zero-server-native`. It has no server API yet.

## Install

```sh
pip install zero-server-core
```

## Use

```python
from zero_server.core import version

print(version())
```
