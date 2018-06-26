# js-libp2p-delegated-content-routing

Leverage other peers in the network to perform Content Routing calls.

## Lead Maintainer

[Jacob Heun](https://github.com/jacobheun)

## Example

```
const DelegatedContentRouting = require('libp2p-delegated-content-routing')

// default is to use ipfs.io
const routing = new DelegatedContentRouing()

routing.findProviders(key, (err, peerInfos) => {
  if (err) {
    return console.error(err)
  }

  console.log('found peers', peerInfos)
})

routing.provide(key, (err) => {
  if (err) {
    return console.error(err)
  }

  console.log('providing %s', key)
})
```

## License

MIT
