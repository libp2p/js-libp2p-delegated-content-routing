# js-libp2p-delegated-content-routing <!-- omit in toc -->

[![](https://img.shields.io/badge/made%20by-Protocol%20Labs-blue.svg?style=flat-square)](http://protocol.ai)
[![](https://img.shields.io/badge/project-libp2p-yellow.svg?style=flat-square)](http://libp2p.io/)
[![](https://img.shields.io/badge/freenode-%23libp2p-yellow.svg?style=flat-square)](http://webchat.freenode.net/?channels=%23libp2p)
[![Discourse posts](https://img.shields.io/discourse/https/discuss.libp2p.io/posts.svg)](https://discuss.libp2p.io)
[![](https://img.shields.io/codecov/c/github/libp2p/js-libp2p-delegated-content-routing.svg?style=flat-square)](https://codecov.io/gh/libp2p/js-libp2p-delegated-content-routing)
[![Build Status](https://github.com/libp2p/js-libp2p-delegated-content-routing/actions/workflows/js-test-and-release.yml/badge.svg?branch=main)](https://github.com/libp2p/js-libp2p-delegated-content-routing/actions/workflows/js-test-and-release.yml)
[![Dependency Status](https://david-dm.org/libp2p/js-libp2p-delegated-content-routing.svg?style=flat-square)](https://david-dm.org/libp2p/js-libp2p-delegated-content-routing)

Leverage other peers in the network to perform Content Routing calls.

Requires access to `/api/v0/dht/findprovs` and `/api/v0/refs` HTTP API endpoints of the delegate node.

## Table of contents <!-- omit in toc -->

- [Requirements](#requirements)
- [Example](#example)
- [License](#license)
  - [Contribution](#contribution)

## Requirements

`@libp2p/delegated-content-routing` leverages the `ipfs-http-client` library and requires an instance of it as a constructor argument.

```sh
npm install ipfs-http-client @libp2p/delegated-content-routing
```

## Example

```js
import { DelegatedContentRouting } from '@libp2p/delegated-content-routing'
import ipfsHttpClient from 'ipfs-http-client'

// default is to use ipfs.io
const routing = new DelegatedContentRouting(peerId, ipfsHttpClient.create({
  // use default api settings
  protocol: 'https',
  port: 443,
  host: 'node0.delegate.ipfs.io' // In production you should setup your own delegates
}))
const cid = new CID('QmS4ustL54uo8FzR9455qaxZwuMiUhyvMcX9Ba8nUH4uVv')

for await (const { id, multiaddrs } of routing.findProviders(cid)) {
  console.log('found peer', id, multiaddrs)
}

await routing.provide(cid)
console.log('providing %s', cid.toBaseEncodedString())
```

## License

Licensed under either of

 * Apache 2.0, ([LICENSE-APACHE](LICENSE-APACHE) / http://www.apache.org/licenses/LICENSE-2.0)
 * MIT ([LICENSE-MIT](LICENSE-MIT) / http://opensource.org/licenses/MIT)

### Contribution

Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion in the work by you, as defined in the Apache-2.0 license, shall be dual licensed as above, without any additional terms or conditions.
