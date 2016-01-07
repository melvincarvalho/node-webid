exports.verify = verify
exports.verifyKey = verifyKey
exports.generate = generate

var $rdf = require('rdflib')
var get = require('../lib/get')
var parse = require('../lib/parse')
var forge = require('node-forge')
var url = require('url')
var crypto = require('crypto')
crypto.DEFAULT_ENCODING = 'buffer'
var certificate = new crypto.Certificate()
var pki = forge.pki
var Graph = $rdf.graph
var SPARQL_QUERY = 'PREFIX cert: <http://www.w3.org/ns/auth/cert#> SELECT ?webid ?m ?e WHERE { ?webid cert:key ?key . ?key cert:modulus ?m . ?key cert:exponent ?e . }'

function verify (certificate, callback) {

  if (!certificate) {
    return callback(new Error('No certificate given'))
  }

  // Collect URIs in certificate
  var uris = getUris(certificate)

  // No uris
  if (uris.length === 0) {
    return callback(new Error('Empty Subject Alternative Name field in certificate'))
  }

  // Get first URI
  var uri = uris.shift()
  get(uri, function (err, body, headers) {
    if (err) {
      return callback(err)
    }

    // Verify Key
    verifyKey(certificate, uri, body, headers, function (err, success) {
      return callback(err, uri)
    })
  })
}

function getUris (certificate) {
  var uris = []

  if (certificate && certificate.subjectaltname) {
    certificate
      .subjectaltname
      .replace(/URI:([^, ]+)/g, function (match, uri) {
        return uris.push(uri)
      })
  }
  return uris
}

function verifyKey (certificate, uri, profile, mimeType, callback) {
  var graph = new Graph()
  var found = false

  if (!certificate.modulus) {
    return callback(new Error('Missing modulus value in client certificate'))
  }

  if (!certificate.exponent) {
    return callback(new Error('Missing exponent value in client certificate'))
  }

  parse(profile, graph, uri, mimeType, function (err) {
    if (err) {
      return callback(err)
    }
    var certExponent = parseInt(certificate.exponent, 16).toString()
    var query = $rdf.SPARQLToQuery(SPARQL_QUERY, undefined, graph)
    graph.query(
      query,
      function (result) {
        if (found) {
          return
        }
        var modulus = result['?m'].value
        var exponent = result['?e'].value

        if (modulus != null &&
           exponent != null &&
           (modulus.toLowerCase() === certificate.modulus.toLowerCase()) &&
           exponent === certExponent) {
          found = true
        }
      },
      undefined, // testing
      function () {
        if (!found) {
          return callback(new Error('Certificate public key not found in the user\'s profile'))
        }
        return callback(null, true)
      }
    )
  })
}

/*
Generate a webid cert.
options should have the uri of the profile in it.

Rewriting to use node-forge.

callback(err, certificate)

@author Cory Sabol
@email cssabol@uncg.edu
@param options The options object { spakc: clientkey, agent: uri }
@param callback The callback to be executed expects args: Error err, Cert certfificate
@return callback
The callback arg cert should be an object reprsentation of the certificate with
the psk12 format of the certificate.
*/
function generate (options, callback) {
  if (!options.agent) {
    return callback(new Error('No agent uri found'))
  }
  if (!options.spkac) {
    return callback(new Error('No public key found'), null)
  }

  // Generate a new keypair to sign the certificate
  var keys = pki.rsa.generateKeyPair(2048)

  // Generate a new certificate
  var cert = pki.createCertificate()

  // Get fields from SPKAC to populate new cert
  var spkac = parseSpkac(options.spkac)
  cert.serialNumber = '01'
  cert.publicKey = pki.publicKeyFromPem(spkac.publicKey)

  // Validity of 1 year
  cert.validity.notBefore = new Date()
  cert.validity.notAfter = new Date()
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1)

  // `.` is default with the OpenSSL command line tool
  var hostname = url.parse(options.agent).hostname
  var attrs = [{
    name: 'commonName',
    value: hostname
  }, {
    name: 'countryName',
    value: options.countryName || '.'
  }, {
    name: 'localityName',
    value: options.localityName || '.'
  }, {
    name: 'organizationName',
    value: options.organizationName || '.'
  }]

  // Set same fields for certificate and issuer
  cert.setSubject(attrs)
  cert.setIssuer(attrs)

  // Set the cert extensions
  cert.setExtensions([
    {
      name: 'subjectAltName',
      altNames: [{
        type: 6, // URI
        value: options.agent
      }]
    }, {
      name: 'subjectKeyIdentifier'
    }
  ])

  cert.sign(keys.privateKey)

  return callback(null, cert)
}

/*
@param spkac The spkac to be parsed.
parse a spkac for it's challenge and publicKey
*/
function parseSpkac (spkac) {
  if (!spkac) {
    throw new Error('no spkac specified')
  }

  if (certificate.verifySpkac(spkac) === false) {
    throw new Error('invalid spkac')
  }

  var rval = {
    // Note that these methods expect a <buffer>
    challenge: certificate.exportChallenge(spkac).toString(),
    publicKey: certificate.exportPublicKey(spkac).toString()
  }

  return rval
}

/*
@param spkac The spkac to be parsed.
Utils to convert a cert as express would parse it
*/
function parseForgeCert (cert) {
  var subject = cert.subject
  var issuer = cert.issuer
  var altName = cert.getExtension('subjectAltName').altNames[0].value

  var rval = {
    subject: { O: subject.getField('O').value, CN: subject.getField('CN').value },
    issuer: { O: issuer.getField('O').value, CN: issuer.getField('CN').value },
    subjectaltname: altName,
    modulus: cert.publicKey.n.toString(),
    exponent: cert.publicKey.e.toString(),
    valid_from: cert.validity.notBefore.toString(),
    valid_to: cert.validity.notAfter.toString(),
    // This breaks at the native level saying that the URI is malformed
    // Need to look into this further
    // fingerprint: pki.getPublicKeyFingerprint(cert.publicKey).toString(),
    fingerprint: '',
    serialNumber: cert.serialNumber
  }
  return rval
}
