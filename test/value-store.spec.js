/* eslint-env mocha */
'use strict'

const loadFixture = require('aegir/utils/fixtures')
const { expect } = require('aegir/utils/chai')
const ipfsHttpClient = require('ipfs-http-client')
const drain = require('it-drain')
const { spawnNode, cleanupNodeFactory } = require('./test-utils')

const DelegatedValueStore = require('../src/value-store')

describe('DelegatedValueStore', function () {
  this.timeout(20 * 1000) // we're spawning daemons, give ci some time

  let delegateNode
  let delegateId

  before(async () => {
    // Spawn a "Boostrap" node that doesnt connect to anything
    const bootstrap = await spawnNode()
    const bootstrapId = bootstrap.id

    // Spawn the delegate node and bootstrap the bootstrapper node
    const delegate = await spawnNode(bootstrapId.addresses)
    delegateNode = delegate.node
    delegateId = await delegateNode.api.id()
  })

  after(() => {
    return cleanupNodeFactory()
  })

  describe('create', () => {
    it('should require the peer id of the delegate node', () => {
      expect(() => new DelegatedValueStore()).to.throw()
    })
    it('should require ipfs http client', () => {
      expect(() => new DelegatedValueStore(delegateId)).to.throw()
    })

    it('should accept an http api client instance at construction time', () => {
      const client = ipfsHttpClient.create({
        protocol: 'http',
        port: 8000,
        host: 'localhost'
      })
      const valueStore = new DelegatedValueStore(delegateId, client)

      expect(valueStore).to.have.property('_client')
        .that.has.property('getEndpointConfig')
        .that.is.a('function')

      expect(valueStore._client.getEndpointConfig()).to.deep.include({
        protocol: 'http:',
        port: '8000',
        host: 'localhost'
      })
    })
  })

  describe('put', async () => {
    it('should associate an IPNS record with a key', async () => {
      const opts = delegateNode.apiAddr.toOptions()
      const valueStore = new DelegatedValueStore(delegateId, ipfsHttpClient.create({
        protocol: 'http',
        port: opts.port,
        host: opts.host
      }))

      const key = new TextEncoder().encode('/ipns/k51qzi5uqu5dgg9b8xoi0yagmbl6iyu0k1epa4hew8jm3z9c7zzmkkl1t4hihu')
      const value = loadFixture('test/fixtures/ipns-k51qzi5uqu5dgg9b8xoi0yagmbl6iyu0k1epa4hew8jm3z9c7zzmkkl1t4hihu.bin')

      await valueStore.put(key, value)

      // check the delegate node to see if the value is retrievable
      const fetched = await delegateNode.api.dht.get(key)
      expect(fetched).to.deep.equal(value)
    })
  })

  describe('get', async () => {
    it('should retrieve an IPNS record for a valid key', async () => {
      const opts = delegateNode.apiAddr.toOptions()
      const valueStore = new DelegatedValueStore(delegateId, ipfsHttpClient.create({
        protocol: 'http',
        port: opts.port,
        host: opts.host
      }))

      const key = new TextEncoder().encode('/ipns/k51qzi5uqu5dgg9b8xoi0yagmbl6iyu0k1epa4hew8jm3z9c7zzmkkl1t4hihu')
      const value = loadFixture('test/fixtures/ipns-k51qzi5uqu5dgg9b8xoi0yagmbl6iyu0k1epa4hew8jm3z9c7zzmkkl1t4hihu.bin')

      // publish the record from the delegate node
      await drain(delegateNode.api.dht.put(key, value))

      // try to fetch it from the js node
      const result = await valueStore.get(key)
      expect(result.from).to.deep.equal(delegateId)
      expect(result.val).to.deep.equal(value)
    })
  })
})
