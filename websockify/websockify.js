#!/usr/bin/env node

// A WebSocket to TCP socket proxy
// Copyright 2012 Joel Martin
// Licensed under LGPL version 3 (see docs/LICENSE.LGPL-3)

// Known to work with node 0.8.9
// Requires node modules: ws and optimist
//     npm install ws optimist


var argv = require('optimist').string('openproxy').parse(process.env.args && process.env.args.split(',')||process.argv.slice(2)),
    net = require('net'),
    http = require('http'),
    https = require('https'),
    url = require('url'),
    path = require('path'),
    fs = require('fs'),
    mime = require('mime-types'),

    Buffer = require('buffer').Buffer,
    WebSocketServer = require('ws').Server,
    serveStatic = require('serve-static'),
    finalhandler = require('finalhandler'),
    moment = require('moment'),

    webServer, wsServer,
    source_host, source_port, target_host, target_port, openproxy, serve,
    web_path = null;


// Handle new WebSocket client
new_client = function(client, req) {
    var clientAddr = client._socket.remoteAddress, log;
    var start_time = new Date().getTime();

    var url = req ? req.url : client.upgradeReq.url;
    var urlregex = /^\/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}),(\d{1,5})/;
    var client_target_host;
    var client_target_port;

    console.log(moment().format()+' ' + clientAddr + ' ' + url);
    var urlparams = urlregex.exec(url);

    if (openproxy) {
        if (!urlparams || urlparams[1].indexOf(openproxy)!==0) {
            console.log('Invalid url parameters, expected "'+openproxy+'.x.x,port" but saw "%s"',url);
            client.close();
            return;
        }
        else {
            client_target_host=urlparams[1];
            client_target_port=urlparams[2];
            log = function (msg) {
                console.log(moment().format()+' ' + clientAddr + '->' + client_target_host + ':' + client_target_port + ': '+ msg);
            };
        }
    }
    else {
        client_target_host=target_host;
        client_target_port=target_port;
        log = function (msg) {
            console.log(moment().format()+' ' + clientAddr + ': '+ msg);
        };
    }
    log('WebSocket connection');
    log('Version ' + client.protocolVersion + ', subprotocol: ' + client.protocol);

    if (argv.record) {
      var rs = fs.createWriteStream(argv.record + '/' + new Date().toISOString().replace(/:/g, "_"));
      rs.write('var VNC_frame_data = [\n');
    } else {
      var rs = null;
    }

    var target = net.createConnection(client_target_port,client_target_host, function() {
        log('connected to target');
    });
    target.on('data', function(data) {
        //log("sending message: " + data);

        if (rs) {
          var tdelta = Math.floor(new Date().getTime()) - start_time;
          var rsdata = '\'{' + tdelta + '{' + decodeBuffer(data) + '\',\n';
          rs.write(rsdata);
        }

        try {
            client.send(data);
        } catch(e) {
            log("Client closed, cleaning up target");
            target.end();
        }
    });
    target.on('end', function() {
        log('target disconnected');
        client.close();
        if (rs) {
          rs.end('\'EOF\'];\n');
        }
    });
    target.on('error', function() {
        log('target connection error');
        target.end();
        client.close();
        if (rs) {
          rs.end('\'EOF\'];\n');
        }
    });

    client.on('message', function(msg) {
        //log('got message: ' + msg);

        if (rs) {
          var rdelta = Math.floor(new Date().getTime()) - start_time;
          var rsdata = ('\'}' + rdelta + '}' + decodeBuffer(msg) + '\',\n');
          rs.write(rsdata);
        }

        target.write(msg);
    });
    client.on('close', function(code, reason) {
        log('WebSocket client disconnected: ' + code + ' [' + reason + ']');
        target.end();
    });
    client.on('error', function(a) {
        log('WebSocket client error: ' + a);
        target.end();
    });
};

function decodeBuffer(buf) {
  var returnString = '';
  for (var i = 0; i < buf.length; i++) {
    if (buf[i] >= 48 && buf[i] <= 90) {
      returnString += String.fromCharCode(buf[i]);
    } else if (buf[i] === 95) {
      returnString += String.fromCharCode(buf[i]);
    } else if (buf[i] >= 97 && buf[i] <= 122) {
      returnString += String.fromCharCode(buf[i]);
    } else {
      var charToConvert = buf[i].toString(16);
      if (charToConvert.length === 0) {
        returnString += '\\x00';
      } else if (charToConvert.length === 1) {
        returnString += '\\x0' + charToConvert;
      } else {
        returnString += '\\x' + charToConvert;
      }
    }
  }
  return returnString;
}

// Send an HTTP error response
http_error = function (response, code, msg) {
    response.writeHead(code, {"Content-Type": "text/plain"});
    response.write(msg + "\n");
    response.end();
    return;
}

// Process an HTTP static file request
http_request = function (request, response) {
//    console.log("pathname: " + url.parse(req.url).pathname);
//    res.writeHead(200, {'Content-Type': 'text/plain'});
//    res.end('okay');

    if (!argv.web || !serve) {
        return http_error(response, 403, "403 Permission Denied");
    }

    var done = finalhandler(request, response);
    serve(request,response,done);
};

// parse source and target arguments into parts
try {
    source_arg = argv._[0].toString();
    target_arg = argv._[1] && argv._[1].toString();

    var idx;
    idx = source_arg.indexOf(":");
    if (idx >= 0) {
        source_host = source_arg.slice(0, idx);
        source_port = parseInt(source_arg.slice(idx+1), 10);
    } else {
        source_host = "";
        source_port = parseInt(source_arg, 10);
    }

    if (target_arg) {

      idx = target_arg.indexOf(":");
      if (idx < 0) {
          throw("target must be host:port");
      }
      target_host = target_arg.slice(0, idx);
      target_port = parseInt(target_arg.slice(idx+1), 10);

    }

    if (isNaN(source_port) || target_arg && isNaN(target_port)) {
        throw("illegal port");
    }
    openproxy = argv.openproxy;
    if (!target_arg && !openproxy) {
        throw("Must supply either openproxy or target_addr:target_port");
    }
    if (target_arg && openproxy) {
        throw("Target and open proxy combined not supported");
    }
    if (openproxy && !/^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(openproxy)) {
        throw("Not two ip octets (ex 192.168): \""+openproxy+"\"");
    }
} catch(e) {
    console.error("websockify.js [--web web_dir] [--cert cert.pem [--key key.pem]] [--record dir] [--openproxy 192.168] [source_addr:]source_port target_addr:target_port");
    process.exit(2);
}

console.log("WebSocket settings: ");
console.log("    - proxying from " + source_host + ":" + source_port);
if (openproxy) {
    console.log("    - Open proxy to net: " + openproxy);
}
else if (target_arg) {
    console.log("    - to " + target_host + ":" + target_port);
}
if (argv.web) {
    serve = serveStatic(argv.web, {'index': ['index.html', 'index.htm']});
    console.log("    - Web server active. Serving: " + argv.web);
}

if (argv.cert) {
    argv.key = argv.key || argv.cert;
    var cert = fs.readFileSync(argv.cert),
        key = fs.readFileSync(argv.key);
    console.log("    - Running in encrypted HTTPS (wss://) mode using: " + argv.cert + ", " + argv.key);
    webServer = https.createServer({cert: cert, key: key}, http_request);
} else {
    console.log("    - Running in unencrypted HTTP (ws://) mode");
    webServer = http.createServer(http_request);
}
webServer.listen(source_port, function() {
    wsServer = new WebSocketServer({server: webServer});
    wsServer.on('connection', new_client);
});
