/* eslint-env mocha */

import { expect } from 'aegir/utils/chai.js'
import { Controller, createFactory } from 'ipfsd-ctl'
import { create, CID } from 'ipfs-http-client'
import all from 'it-all'
import drain from 'it-drain'
import { isNode } from 'wherearewe'
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string'
import { DelegatedContentRouting } from '../src/index.js'
// @ts-expect-error no types
import goIpfs from 'go-ipfs'
import { peerIdFromString } from '@libp2p/peer-id'
import type { PeerId } from '@libp2p/interfaces/peer-id'
import type { IDResult } from 'ipfs-core-types/src/root'
import type { PeerData } from 'ipfs-core-types/src/dht/index.js'

const factory = createFactory({
  type: 'go',
  ipfsHttpModule: { create },
  ipfsBin: isNode ? goIpfs.path() : undefined,
  test: true,
  endpoint: 'http://localhost:57483'
})

async function spawnNode (bootstrap: any[] = []) {
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

describe('DelegatedContentRouting', function () {
  this.timeout(20 * 1000) // we're spawning daemons, give ci some time

  let selfNode: Controller
  let selfId: PeerId
  let delegateNode: Controller
  let bootstrapNode: Controller
  let bootstrapId: IDResult

  before(async () => {
    // Spawn a "Boostrap" node that doesnt connect to anything
    const bootstrap = await spawnNode()
    bootstrapNode = bootstrap.node
    bootstrapId = bootstrap.id

    // Spawn our local node and bootstrap the bootstrapper node
    const self = await spawnNode(bootstrapId.addresses)
    selfNode = self.node
    selfId = peerIdFromString(self.id.id)

    // Spawn the delegate node and bootstrap the bootstrapper node
    const delegate = await spawnNode(bootstrapId.addresses)
    delegateNode = delegate.node
  })

  after(async () => {
    return await factory.clean()
  })

  describe('create', () => {
    it('should require ipfs http client', () => {
      // @ts-expect-error missing parameters
      expect(() => new DelegatedContentRouting()).to.throw()
    })

    it('should accept an http api client instance at construction time', () => {
      const client = create({
        protocol: 'http',
        port: 8000,
        host: 'localhost'
      })
      const router = new DelegatedContentRouting(client)

      expect(router).to.have.property('client')
        .that.has.property('getEndpointConfig')
        .that.is.a('function')

      expect(client.getEndpointConfig()).to.deep.include({
        protocol: 'http:',
        port: '8000',
        host: 'localhost'
      })
    })
  })

  describe('findProviders', () => {
    const data = uint8ArrayFromString('some data')
    const cid = CID.parse('QmVv4Wz46JaZJeH5PMV4LGbRiiMKEmszPYY3g6fjGnVXBS') // 'some data'

    before('register providers', async () => {
      await Promise.all([
        bootstrapNode.api.add(data),
        selfNode.api.add(data)
      ])
      await Promise.all([
        drain(bootstrapNode.api.dht.provide(cid)),
        drain(selfNode.api.dht.provide(cid))
      ])
    })

    it('should be able to find providers through the delegate node', async function () {
      const opts = delegateNode.apiAddr.toOptions()
      const routing = new DelegatedContentRouting(create({
        protocol: 'http',
        port: opts.port,
        host: opts.host
      }))

      const events = await all(routing.findProviders(cid))
      const providers: PeerData[] = []

      for (const event of events) {
        if (event.name === 'PEER_RESPONSE') {
          providers.push(...event.providers)
        }
      }

      // We should get the bootstrap node as provider
      // The delegate node is not included, because it is handling the requests
      expect(providers.map((p) => p.id.toString())).to.include(bootstrapId.id, 'Did not include bootstrap node')
      expect(providers.map((p) => p.id.toString())).to.include(selfId.toString(), 'Did not include self node')
    })

    it('should be able to specify a timeout', async () => {
      const opts = delegateNode.apiAddr.toOptions()
      const routing = new DelegatedContentRouting(create({
        protocol: 'http',
        port: opts.port,
        host: opts.host
      }))

      const events = await all(routing.findProviders(cid, { timeout: 5e3 }))
      const providers: PeerData[] = []

      for (const event of events) {
        if (event.name === 'PEER_RESPONSE') {
          providers.push(...event.providers)
        }
      }

      expect(providers.map((p) => p.id.toString())).to.include(bootstrapId.id, 'Did not include bootstrap node')
    })
  })

  describe('provide', () => {
    it('should be able to register as a content provider to the delegate node', async () => {
      const opts = delegateNode.apiAddr.toOptions()
      const contentRouter = new DelegatedContentRouting(create({
        protocol: 'http',
        port: opts.port,
        host: opts.host
      }))

      const { cid } = await selfNode.api.add(uint8ArrayFromString(`hello-${Math.random()}`))

      await contentRouter.provide(cid)

      const providers: PeerData[] = []

      for await (const event of delegateNode.api.dht.findProvs(cid)) {
        if (event.name === 'PEER_RESPONSE') {
          providers.push(...event.providers)
        }
      }

      // We are hosting the file, validate we're the provider
      expect(providers.map((p) => p.id)).to.include(selfId.toString(), 'Did not include self node')
    })

    it('should provide non-dag-pb nodes via the delegate node', async () => {
      const opts = delegateNode.apiAddr.toOptions()
      const contentRouter = new DelegatedContentRouting(create({
        protocol: 'http',
        port: opts.port,
        host: opts.host
      }))

      const cid = await selfNode.api.dag.put(`hello-${Math.random()}`, {
        storeCodec: 'dag-cbor',
        hashAlg: 'sha2-256'
      })

      await contentRouter.provide(cid)

      const providers: PeerData[] = []

      for await (const event of delegateNode.api.dht.findProvs(cid)) {
        if (event.name === 'PEER_RESPONSE') {
          providers.push(...event.providers)
        }
      }

      // We are hosting the file, validate we're the provider
      expect(providers.map((p) => p.id)).to.include(selfId.toString(), 'Did not include self node')
    })
  })
})
