'use strict'

const { createFactory } = require('ipfsd-ctl')
const { isNode } = require('ipfs-utils/src/env')

const factory = createFactory({
  type: 'go',
  ipfsHttpModule: require('ipfs-http-client'),
  ipfsBin: isNode ? require('go-ipfs').path() : undefined,
  test: true,
  endpoint: 'http://localhost:57483'
})

async function spawnNode (bootstrap = []) {
  const node = await factory.spawn({
    // Lock down the nodes so testing can be deterministic
    ipfsOptions: {
      config: {
        Bootstrap: bootstrap,
        Discovery: {
          MDNS: {
            Enabled: false
          }
        }
      }
    }
  })

  const id = await node.api.id()

  return {
    node,
    id
  }
}

function cleanupNodeFactory () {
  return factory.clean()
}

module.exports = {
  spawnNode,
  cleanupNodeFactory
}
