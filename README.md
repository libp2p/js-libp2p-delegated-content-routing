# js-libp2p-delegated-content-routing

[![](https://img.shields.io/badge/made%20by-Protocol%20Labs-blue.svg?style=flat-square)](http://protocol.ai)
[![](https://img.shields.io/badge/project-libp2p-yellow.svg?style=flat-square)](http://libp2p.io/)
[![](https://img.shields.io/badge/freenode-%23libp2p-yellow.svg?style=flat-square)](http://webchat.freenode.net/?channels=%23libp2p)
[![Discourse posts](https://img.shields.io/discourse/https/discuss.libp2p.io/posts.svg)](https://discuss.libp2p.io)
[![](https://img.shields.io/codecov/c/github/libp2p/js-libp2p-delegated-content-routing.svg?style=flat-square)](https://codecov.io/gh/libp2p/js-libp2p-delegated-content-routing)
[![](https://img.shields.io/travis/libp2p/js-libp2p-delegated-content-routing.svg?style=flat-square)](https://travis-ci.com/libp2p/js-libp2p-delegated-content-routing)
[![Dependency Status](https://david-dm.org/libp2p/js-libp2p-delegated-content-routing.svg?style=flat-square)](https://david-dm.org/libp2p/js-libp2p-delegated-content-routing)

Leverage other peers in the network to perform Content Routing calls.

## Lead Maintainer

[Jacob Heun](https://github.com/jacobheun)

## Example

```js
const DelegatedContentRouting = require('libp2p-delegated-content-routing')

// default is to use ipfs.io
const routing = new DelegatedContentRouing(peerId, {
  // use default api settings
  protocol: 'https',
  port: 443,
  host: 'ipfs.io'
})
const cid = new CID('QmS4ustL54uo8FzR9455qaxZwuMiUhyvMcX9Ba8nUH4uVv')

for await (const peerInfo of routing.findProviders(cid)) {
  console.log('found peer', peerInfo)
}

await routing.provide(cid)
console.log('providing %s', cid.toBaseEncodedString())
```

## License

MIT
