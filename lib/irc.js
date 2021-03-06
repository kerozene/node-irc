/*
    irc.js - Node JS IRC client library

    (C) Copyright Martyn Smith 2010

    This library is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This library is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this library.  If not, see <http://www.gnu.org/licenses/>.
*/

exports.Client = Client;
var net  = require('net');
var tls  = require('tls');
var util = require('util');
var EventEmitter = require('events').EventEmitter;
var _    = require('lodash');
var callerId = require('caller-id');

var colors = require('./colors');
var parseMessage = require('./parse_message');
exports.colors = colors;

var lineDelimiter = new RegExp('\r\n|\r|\n');

function Client(server, nick, opt) {
    var self = this;
    self.opt = {
        server: server,
        nick: nick,
        password: null,
        userName: 'nodebot',
        realName: 'nodeJS IRC client',
        port: 6667,
        localAddress: null,
        debug: false,
        showErrors: false,
        autoRejoin: false,
        autoConnect: true,
        channels: [],
        retryCount: null,
        retryDelay: 2000,
        secure: false,
        selfSigned: false,
        certExpired: false,
        floodProtection: false,
        floodProtectionDelay: 1000,
        sasl: false,
        capabilities: [],
        stripColors: false,
        channelPrefixes: '&#',
        messageSplit: 512,
        encoding: false,
        webirc: {
          pass: '',
          ip: '',
          user: ''
        }
    };

    // Features supported by the server
    // (initial values are RFC 1459 defaults. Zeros signify
    // no default or unlimited value)
    self.supported = {
        channel: {
            idlength: [],
            length: 200,
            limit: [],
            modes: { a: '', b: '', c: '', d: ''},
            types: self.opt.channelPrefixes
        },
        kicklength: 0,
        maxlist: [],
        maxtargets: [],
        modes: 3,
        nicklength: 9,
        topiclength: 0,
        usermodes: '',
        whox: false,
        capabilities: {}
    };

    if (typeof arguments[2] == 'object') {
        var keys = Object.keys(self.opt);
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            if (arguments[2][k] !== undefined)
                self.opt[k] = arguments[2][k];
        }
    }

    if (self.opt.floodProtection) {
        self.activateFloodProtection();
    }

    self.hostMask = '';

    // TODO - fail if nick or server missing
    // TODO - fail if username has a space in it
    if (self.opt.autoConnect === true) {
        self.connect();
    }

    self.addListener('raw', function(message) {
        var channels = [],
            channel,
            nick,
            from,
            text,
            to;

        switch (message.command) {
            case 'rpl_welcome':
                // Set nick to whatever the server decided it really is
                // (normally this is because you chose something too long and
                // the server has shortened it
                self.nick = message.args[0];
                // Note our hostmask to use it in splitting long messages.
                // We don't send our hostmask when issuing PRIVMSGs or NOTICEs,
                // of course, but rather the servers on the other side will
                // include it in messages and will truncate what we send if
                // the string is too long. Therefore, we need to be considerate
                // neighbors and truncate our messages accordingly.
                var welcomeStringWords = message.args[1].split(/\s+/);
                self.hostMask = welcomeStringWords[welcomeStringWords.length - 1];
                self._updateMaxLineLength();
                self.emit('registered', message);
                break;
            case 'rpl_myinfo':
                self.supported.usermodes = message.args[3];
                break;
            case 'rpl_isupport':
                message.args.forEach(function(arg) {
                    var match;
                    match = arg.match(/([A-Z]+)(?:=(.*))?/);
                    if (match) {
                        var param = match[1];
                        var value = match[2];
                        switch (param) {
                            case 'CHANLIMIT':
                                value.split(',').forEach(function(val) {
                                    val = val.split(':');
                                    self.supported.channel.limit[val[0]] = parseInt(val[1]);
                                });
                                break;
                            case 'CHANMODES':
                                value = value.split(',');
                                var type = ['a', 'b', 'c', 'd'];
                                for (var i = 0; i < type.length; i++) {
                                    self.supported.channel.modes[type[i]] += value[i];
                                }
                                break;
                            case 'CHANTYPES':
                                self.supported.channel.types = value;
                                break;
                            case 'CHANNELLEN':
                                self.supported.channel.length = parseInt(value);
                                break;
                            case 'IDCHAN':
                                value.split(',').forEach(function(val) {
                                    val = val.split(':');
                                    self.supported.channel.idlength[val[0]] = val[1];
                                });
                                break;
                            case 'MODES':
                                self.supported.modes = parseInt(value);
                                break;
                            case 'KICKLEN':
                                self.supported.kicklength = value;
                                break;
                            case 'MAXLIST':
                                value.split(',').forEach(function(val) {
                                    val = val.split(':');
                                    self.supported.maxlist[val[0]] = parseInt(val[1]);
                                });
                                break;
                            case 'NICKLEN':
                                self.supported.nicklength = parseInt(value);
                                break;
                            case 'PREFIX':
                                match = value.match(/\((.*?)\)(.*)/);
                                if (match) {
                                    match[1] = match[1].split('');
                                    match[2] = match[2].split('');
                                    while (match[1].length) {
                                        self.modeForPrefix[match[2][0]] = match[1][0];
                                        self.supported.channel.modes.b += match[1][0];
                                        self.prefixForMode[match[1].shift()] = match[2].shift();
                                    }
                                }
                                break;
                            case 'STATUSMSG':
                                break;
                            case 'TARGMAX':
                                value.split(',').forEach(function(val) {
                                    val = val.split(':');
                                    val[1] = (!val[1]) ? 0 : parseInt(val[1]);
                                    self.supported.maxtargets[val[0]] = val[1];
                                });
                                break;
                            case 'TOPICLEN':
                                self.supported.topiclength = parseInt(value);
                                break;
                            case 'WHOX':
                                self.supported.whox = true;
                                break;
                        }
                    }
                });
                break;
            case 'rpl_yourhost':
            case 'rpl_created':
            case 'rpl_luserunknown':
            case 'rpl_luserclient':
            case 'rpl_luserop':
            case 'rpl_luserchannels':
            case 'rpl_luserme':
            case 'rpl_localusers':
            case 'rpl_globalusers':
            case 'rpl_statsconn':
                // Random welcome crap, ignoring
                break;
            case 'err_nicknameinuse':
                if (typeof (self.opt.nickMod) == 'undefined')
                    self.opt.nickMod = 0;
                self.opt.nickMod++;
                self.send('NICK', self.opt.nick + self.opt.nickMod);
                self.nick = self.opt.nick + self.opt.nickMod;
                self._updateMaxLineLength();
                break;
            case 'PING':
                self.send('PONG', message.args[0]);
                self.emit('ping', message.args[0]);
                break;
            case 'PONG':
                self.emit('pong', message.args[0]);
                break;
            case 'NOTICE':
                from = message.nick;
                to = message.args[0];
                if (!to) {
                    to = null;
                }
                text = message.args[1] || '';
                if (text[0] === '\u0001' && text.lastIndexOf('\u0001') > 0) {
                    self._handleCTCP(from, to, text, 'notice', message);
                    break;
                }
                self.emit('notice', from, to, text, message);

                if (self.opt.debug && to == self.nick)
                    util.log('GOT NOTICE from ' + (from ? '"' + from + '"' : 'the server') + ': "' + text + '"');
                break;
            case 'MODE':
                if (self.opt.debug)
                    util.log('MODE: ' + message.args[0] + ' sets mode: ' + message.args[1]);

                var chan = self.chanData(message.args[0]);
                if (!chan) break;
                var modeList = message.args[1].split('');
                var adding = true;
                var modeArgs = message.args.slice(2);
                modeList.forEach(function(mode) {
                    if (mode == '+') {
                        adding = true;
                        return;
                    }
                    if (mode == '-') {
                        adding = false;
                        return;
                    }
                    if (mode in self.prefixForMode) {
                        // channel user modes
                        var nick = modeArgs.shift();
                        var user = chan.users[nick];
                        if (!user) {
                            if (self.opt.debug)
                                util.log('\u001b[01,31mWARNING: server set mode ' + (adding?'+':'-') + mode +
                                            ' on non-existent nick ' + nick + ' in ' + message.args[0] + '\u001b[0m');
                            return;
                        }
                        mode = self.prefixForMode[mode];
                        if (!user.modes)
                            user.modes = [];
                        var hasMode = _.contains(user.modes, mode);
                        if (adding) {
                            if (!hasMode)
                                user.modes.push(mode);
                        }
                        else if (hasMode)
                                user.modes = _.without(user.modes, mode);

                        self.emit((adding?'+':'-') + 'mode', message.args[0], message.nick, mode, user, message);
                        if (self.nick == nick)
                            self.emit((adding?'+':'-') + 'selfmode', message.args[0], message.nick, mode, user, message);
                    }
                    else {
                        var modeArg;
                        // channel modes
                        if (mode.match(/^[bkl]$/)) {
                            modeArg = modeArgs.shift();
                            if (modeArg.length === 0)
                                modeArg = undefined;
                        }
                        // TODO - deal nicely with channel modes that take args
                        if (adding) {
                            if (chan.mode.indexOf(mode) === -1)
                                chan.mode += mode;

                            self.emit('+mode', message.args[0], message.nick, mode, modeArg, message);
                        }
                        else {
                            chan.mode = chan.mode.replace(mode, '');
                            self.emit('-mode', message.args[0], message.nick, mode, modeArg, message);
                        }
                    }
                });
                break;
            case 'NICK':
                var newNick = message.args[0],
                    oldNick = message.nick;
                if (oldNick == self.nick) {
                    // the user just changed their own nick
                    self.nick = newNick;
                    self._updateMaxLineLength();
                    self.emit('selfnick', oldNick, newNick, message);
                }

                if (self.opt.debug)
                    util.log('NICK: ' + oldNick + ' changes nick to ' + newNick);

                channels = [];
                _.each(self.nickInChannels(oldNick), function(channel) {
                    var chan = self.chans[channel];
                    chan.users[newNick] = chan.users[oldNick];
                    delete chan.users[oldNick];
                    channels.push(channel);
                    self.emit('nick' + channel, oldNick, newNick, message);
                });
                self.emit('nick', oldNick, newNick, channels, message);
                break;
            case 'rpl_motdstart':
                self.motd = message.args[1] + '\n';
                break;
            case 'rpl_motd':
                self.motd += message.args[1] + '\n';
                break;
            case 'rpl_endofmotd':
            case 'err_nomotd':
                self.motd += message.args[1] + '\n';
                self.emit('motd', self.motd);
                break;
            case 'rpl_namreply':
/*
                channel = self.chanData(message.args[2]);
                var users = message.args[3].trim().split(/ +/);
                if (channel) {
                    users.forEach(function(user) {
                        var match = user.match(/^(.)(.*)$/);
                        if (match) {
                            if (match[1] in self.modeForPrefix) {
                                channel.users[match[2]] = match[1];
                            }
                            else {
                                channel.users[match[1] + match[2]] = '';
                            }
                        }
                    });
                }
*/
                break;
            case 'rpl_endofnames':
/*                channel = self.chanData(message.args[1]);
                if (channel) {
                    self.emit('names', message.args[1], channel.users);
                    self.emit('names' + message.args[1], channel.users);
                }
*/
                break;
            case 'rpl_topic':
                channel = self.chanData(message.args[1]);
                if (channel) {
                    channel.topic = message.args[2];
                }
                break;
            case 'rpl_away':
                self._addWhoisData(message.args[1], 'away', message.args[2], true);
                break;
            case 'rpl_whoisuser':
                self._addWhoisData(message.args[1], 'user', message.args[2]);
                self._addWhoisData(message.args[1], 'host', message.args[3]);
                self._addWhoisData(message.args[1], 'realname', message.args[5]);
                break;
            case 'rpl_whoisidle':
                self._addWhoisData(message.args[1], 'idle', message.args[2]);
                break;
            case 'rpl_whoischannels':
               // TODO - clean this up?
                self._addWhoisData(message.args[1], 'channels', message.args[2].trim().split(/\s+/));
                break;
            case 'rpl_whoisserver':
                self._addWhoisData(message.args[1], 'server', message.args[2]);
                self._addWhoisData(message.args[1], 'serverinfo', message.args[3]);
                break;
            case 'rpl_whoisoperator':
                self._addWhoisData(message.args[1], 'operator', message.args[2]);
                break;
            case '330': // rpl_whoisaccount?
                self._addWhoisData(message.args[1], 'account', message.args[2]);
                self._addWhoisData(message.args[1], 'accountinfo', message.args[3]);
                break;
            case 'rpl_endofwhois':
                self.emit('whois', self._clearWhoisData(message.args[1]));
                break;
            case 'rpl_whoreply':
            case '354':
                self._addWhoData(message.args.slice(1));
                break;
            case 'rpl_endofwho':
                var whoData = self._clearWhoData(message.args[1]);
                if (self.chanData(message.args[1])) {
                    if (whoData[1] && whoData[1].length)
                        self._addWhoDataToChan(whoData[0], whoData[1]);
                    self.emit('who' + whoData[0], whoData[1]);
                }
                self.emit('who', whoData[0], whoData[1]);
                break;
            case 'rpl_liststart':
                self.channellist = [];
                self.emit('channellist_start');
                break;
            case 'rpl_list':
                channel = {
                    name: message.args[1],
                    users: message.args[2],
                    topic: message.args[3]
                };
                self.emit('channellist_item', channel);
                self.channellist.push(channel);
                break;
            case 'rpl_listend':
                self.emit('channellist', self.channellist);
                break;
            case 'rpl_topicwhotime':
                channel = self.chanData(message.args[1]);
                if (channel) {
                    channel.topicBy = message.args[2];
                    // channel, topic, nick
                    self.emit('topic', message.args[1], channel.topic, channel.topicBy, message);
                }
                break;
            case 'TOPIC':
                // channel, topic, nick
                self.emit('topic', message.args[0], message.args[1], message.nick, message);

                channel = self.chanData(message.args[0]);
                if (channel) {
                    channel.topic = message.args[1];
                    channel.topicBy = message.nick;
                }
                break;
            case 'rpl_channelmodeis':
                channel = self.chanData(message.args[1]);
                if (channel) {
                    channel.mode = message.args[2];
                }
                break;
            case 'rpl_creationtime':
                channel = self.chanData(message.args[1]);
                if (channel) {
                    channel.created = message.args[2];
                }
                break;
            case 'JOIN':
                // channel, who
                channel = message.args[0];
                self._addJoinDataToChan(self.chanData(channel, true), message);
                if (self.nick == message.nick) {
                    self.syncChans[channel] = _.now();
                    self.send('MODE', channel);
                    self.who(channel, (self.supported.whox ? '%cuhnfa' : ''));
                    self.emit('selfjoin', channel, message);
                    self.emit('selfjoin' + channel, message);
                    if (channel != channel.toLowerCase()) {
                        self.emit('selfjoin' + channel.toLowerCase(), message);
                    }
                }
                self.emit('join', channel, message.nick, message);
                self.emit('join' + channel, message.nick, message);
                if (channel != channel.toLowerCase()) {
                    self.emit('join' + channel.toLowerCase(), message.nick, message);
                }
                break;
            case 'PART':
                // channel, who, reason
                channel = message.args[0];
                self.emit('part', channel, message.nick, message.args[1], message);
                self.emit('part' + channel, message.nick, message.args[1], message);
                if (channel != channel.toLowerCase()) {
                    self.emit('part' + channel.toLowerCase(), message.nick, message.args[1], message);
                }
                chan = self.chanData(channel);
                if (self.nick == message.nick) {
                    delete self.chans[chan.key];
                    self.emit('selfpart', channel, message.args[1], message);
                    self.emit('selfpart' + channel, message.args[1], message);
                    if (channel != channel.toLowerCase()) {
                        self.emit('selfpart' + channel.toLowerCase(), message.args[1], message);
                    }
                }
                else if (chan && chan.users)
                    delete chan.users[message.nick];
                break;
            case 'KICK':
                // channel, who, by, reason
                channel = message.args[0];
                nick = message.args[1];
                self.emit('kick', channel, nick, message.nick, message.args[2], message);
                self.emit('kick' + channel, nick, message.nick, message.args[2], message);
                if (channel != channel.toLowerCase()) {
                    self.emit('kick' + channel.toLowerCase(),
                              nick, message.nick, message.args[2], message);
                }

                if (self.nick == nick) {
                    chan = self.chanData(channel);
                    delete self.chans[chan.key];
                    self.emit('selfkick', channel, message.nick, message.args[2], message);
                    self.emit('selfkick' + channel, message.nick, message.args[2], message);
                    if (channel != channel.toLowerCase()) {
                        self.emit('selfkick' + channel.toLowerCase(),
                                  message.nick, message.args[2], message);
                    }
                }
                else
                    self.nickIsInChannel(nick, channel, 'remove');
                break;
            case 'KILL':
                nick = message.args[0];
                channels = [];
                _.each(self.nickInChannels(nick, 'remove'), function (channel) {
                    channels.push(channel);
                    self.emit('kill' + channel, nick, message.args[1], message);
                });
                self.emit('kill', nick, message.args[1], channels, message);
                break;
            case 'PRIVMSG':
                from = message.nick;
                to = message.args[0];
                text = message.args[1] || '';
                if (text[0] === '\u0001' && text.lastIndexOf('\u0001') > 0) {
                    self._handleCTCP(from, to, text, 'privmsg', message);
                    break;
                }
                self.emit('message', from, to, text, message);
                if (self.supported.channel.types.indexOf(to.charAt(0)) !== -1) {
                    self.emit('message#', from, to, text, message);
                    self.emit('message' + to, from, text, message);
                    if (to != to.toLowerCase()) {
                        self.emit('message' + to.toLowerCase(), from, text, message);
                    }
                }
                if (to.toUpperCase() === self.nick.toUpperCase()) self.emit('pm', from, text, message);

                if (self.opt.debug && to == self.nick)
                    util.log('GOT MESSAGE from ' + from + ': ' + text);
                break;
            case 'INVITE':
                from = message.nick;
                to = message.args[0];
                channel = message.args[1];
                self.emit('invite', channel, from, message);
                break;
            case 'QUIT':
                if (self.opt.debug)
                    util.log('QUIT: ' + message.prefix + ' ' + message.args.join(' '));
                if (self.nick == message.nick) {
                    // TODO handle?
                    break;
                }
                // handle other people quitting

                channels = [];
                var remove = (message.args[0] != 'Changing host') ? true : undefined;
                _.each(self.nickInChannels(message.nick, remove), function (channel) {
                    channels.push(channel);
                    self.emit('quit' + channel, message.nick, message.args[0], message);
                    if (remove)
                        self.emit('realquit' + channel, message.nick, message.args[0], message);
                });

                // who, reason, channels
                self.emit('quit', message.nick, message.args[0], channels, message);
                if (remove)
                    self.emit('realquit', message.nick, message.args[0], channels, message);
                break;

            // for sasl
            case 'CAP':
                if (message.args[1] === 'LS') {
                    var capabilitiesList = message.args[2].split(' ');
                    if (message.args[2] === '*') {
                        capabilitiesList = message.args[3].split(' ');
                    }
                    _.each(capabilitiesList, function(cap) {
                        cap = cap.split('=');
                        self.supported.capabilities[cap[0]] = cap[1];
                    });
                    if (message.args[2] !== '*') {
                        self.emit('cap-ls', self.supported.capabilities);
                        if (self.opt.debug)
                            util.log('Capabilities supported: ' + _.keys(self.supported.capabilities).join(' '));
                    }
                    self._capabilitiesReq = _.intersection(self.opt.capabilities, _.keys(self.supported.capabilities));
                    var unsupportedCapabilities = _.difference(self.opt.capabilities, self._capabilitiesReq);
                    if (unsupportedCapabilities.length && self.opt.debug)
                        util.log('CAP LS: not requesting unsupported capabilities: ' + unsupportedCapabilities.join(', '));
                    if (self.opt.sasl === true) {
                        self._capabilitiesReq.push('sasl');
                    }
                    if (self._capabilitiesReq.length) {
                        self.send('CAP', 'REQ', _.uniq(self._capabilitiesReq).join(' '));
                    }
                } else if (message.args[1] === 'ACK') {
                    self.capabilities = _.union(
                        self.capabilities,
                        _.intersection(self._capabilitiesReq, message.args[2].split(' ')) // can ACK
                    );
                    self._capabilitiesReq = _.difference(self._capabilitiesReq, self.capabilities); // remaining
                    if (self._capabilitiesReq.length == 0) {
                        if (self.opt.debug)
                            util.log('Capabilities enabled: ' + self.capabilities.join(' '));
                        if (_.contains(self.capabilities, 'sasl')) {
                            self.send('AUTHENTICATE', 'PLAIN');
                        } else {
                            self.send('CAP', 'END');
                            self.emit('cap-end');
                        }
                    }
                } else if (message.args[1] === 'NAK') {
                    if (self.opt.debug)
                        util.log('\u001b[01,31mWARNING: ' + 'CAP REQ denied: ' + message.args[2] + '\u001b[0m');
                    var capabilitiesNak = _.intersection(self._capabilitiesReq, message.args[2].split(' ')); // can NAK
                    self._capabilitiesReq = _.difference(self._capabilitiesReq, self.capabilities); // remaining
                    if (!self._capabilitiesReq.length) {
                        self.send('CAP', 'END');
                        self.emit('cap-end');
                    }
                }
                break;
            case 'AUTHENTICATE':
                if (message.args[0] === '+') self.send('AUTHENTICATE',
                    new Buffer(
                        self.opt.userName + '\0' +
                        self.opt.userName + '\0' +
                        self.opt.password
                    ).toString('base64'));
                break;
            case '900':
                util.log(message.args[3]); // 'You are now logged in as *'
                break;
            case '903':
                self.emit('sasl-authenticated');
                self.send('CAP', 'END');
                self.emit('cap-end');
                break;
            case '904':
            case '905':
            case '906':
            case '907':
                self.emit('sasl-authentication-failed');
                if (self.opt.debug)
                    util.log('\u001b[01;31mWARNING: ' + 'SASL auth failed' + '\u001b[0m');
                self.send('CAP', 'END');
                self.emit('cap-end');
                break;
            case 'ACCOUNT':
                if (self.opt.debug)
                    util.log('ACCOUNT: ' + message.nick + ' -> ' + message.args[0]);
                self._updateNickAccount(message.nick, message.args[0]);
                break;
            case 'err_umodeunknownflag':
                if (self.opt.showErrors)
                    util.log('\u001b[01;31mERROR: ' + util.inspect(message) + '\u001b[0m');
                break;

            case 'err_erroneusnickname':
                if (self.opt.showErrors)
                    util.log('\u001b[01;31mERROR: ' + util.inspect(message) + '\u001b[0m');
                self.emit('error', message);
                break;

            default:
                if (message.commandType == 'error') {
                    self.emit('error', message);
                    if (self.opt.showErrors)
                        util.log('\u001b[01;31mERROR: ' + util.inspect(message) + '\u001b[0m');
                }
                else {
                    if (self.opt.debug)
                        util.log('\u001b[01;31mUnhandled message: ' + util.inspect(message) + '\u001b[0m');
                    break;
                }
        }
    });

    self.addListener('kick', function(channel, who, by, reason) {
        if (self.opt.autoRejoin)
            self.send.apply(self, ['JOIN'].concat(channel.split(' ')));
    });
    self.addListener('motd', function(motd) {
        self.opt.channels.forEach(function(channel) {
            self.send.apply(self, ['JOIN'].concat(channel.split(' ')));
        });
    });

    EventEmitter.call(this);
}
util.inherits(Client, EventEmitter);

Client.prototype.conn = null;
Client.prototype.prefixForMode = {};
Client.prototype.modeForPrefix = {};
Client.prototype.chans = {};
Client.prototype.syncChans = {};
Client.prototype._whoisData = {};
Client.prototype._who = {
    data:   [],
    queue:  [],
    format: '%cuhsnfdr',
    fields: {
        t: 'type',      c: 'channel',    u: 'username',  i: 'ip',
        h: 'host',      s: 'server',     n: 'nick',      f: 'status',
        d: 'hops',      l: 'idle',       a: 'account',   r: 'realname'
    }
};

Client.prototype._capabilitiesReq = [];

Client.prototype.chanData = function(name, create) {
    var key = name.toLowerCase();
    if (create) {
        this.chans[key] = this.chans[key] || {
            key: key,
            serverName: name,
            users: {},
            mode: ''
        };
    }

    return this.chans[key];
};

Client.prototype._connectionHandler = function() {
    if (this.opt.webirc.ip && this.opt.webirc.pass && this.opt.webirc.host) {
        this.send('WEBIRC', this.opt.webirc.pass, this.opt.userName, this.opt.webirc.host, this.opt.webirc.ip);
    }
    if (this.opt.password && !this.opt.sasl) {
        this.send('PASS', this.opt.password);
    }
    this.send('CAP', 'LS', '302');
    if (this.opt.debug)
        util.log('Sending irc NICK/USER');
    this.send('NICK', this.opt.nick);
    this.nick = this.opt.nick;
    this._updateMaxLineLength();
    this.send('USER', this.opt.userName, 8, '*', this.opt.realName);
    this.addListener('cap-end', function() {
        this.emit('connect');
    });
};

Client.prototype.connect = function(retryCount, callback) {
    if (typeof (retryCount) === 'function') {
        callback = retryCount;
        retryCount = undefined;
    }
    retryCount = retryCount || 0;
    if (typeof (callback) === 'function') {
        this.once('registered', callback);
    }
    var self = this;
    self.chans = {};

    // socket opts
    var connectionOpts = {
        host: self.opt.server,
        port: self.opt.port
    };

    // local address to bind to
    if (self.opt.localAddress)
        connectionOpts.localAddress = self.opt.localAddress;

    // try to connect to the server
    if (self.opt.secure) {
        connectionOpts.rejectUnauthorized = !self.opt.selfSigned;

        if (typeof self.opt.secure == 'object') {
            // copy "secure" opts to options passed to connect()
            for (var f in self.opt.secure) {
                connectionOpts[f] = self.opt.secure[f];
            }
        }

        self.conn = tls.connect(connectionOpts, function() {
            // callback called only after successful socket connection
            self.conn.connected = true;
            if (self.conn.authorized ||
                (self.opt.selfSigned &&
                    (self.conn.authorizationError   === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
                     self.conn.authorizationError === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
                     self.conn.authorizationError === 'SELF_SIGNED_CERT_IN_CHAIN')) ||
                (self.opt.certExpired &&
                 self.conn.authorizationError === 'CERT_HAS_EXPIRED')) {
                // authorization successful

                if (!self.opt.encoding) {
                    self.conn.setEncoding('utf-8');
                }

                if (self.opt.certExpired &&
                    self.conn.authorizationError === 'CERT_HAS_EXPIRED') {
                    util.log('Connecting to server with expired certificate');
                }

                self._connectionHandler();
            } else {
                // authorization failed
                util.log(self.conn.authorizationError);
            }
        });
    } else {
        self.conn = net.createConnection(connectionOpts, self._connectionHandler.bind(self));
    }
    self.conn.requestedDisconnect = false;
    self.conn.setTimeout(0);

    if (!self.opt.encoding) {
        self.conn.setEncoding('utf8');
    }

    var buffer = new Buffer('');

    self.conn.addListener('data', function(chunk) {
        if (typeof (chunk) === 'string') {
            buffer += chunk;
        } else {
            buffer = Buffer.concat([buffer, chunk]);
        }

        var lines = self.convertEncoding(buffer).toString().split(lineDelimiter);

        if (lines.pop()) {
            // if buffer is not ended with \r\n, there's more chunks.
            return;
        } else {
            // else, initialize the buffer.
            buffer = new Buffer('');
        }

        lines.forEach(function iterator(line) {
            if (line.length) {
                var message = parseMessage(line, self.opt.stripColors);

                try {
                    self.emit('raw', message);
                } catch (err) {
                    if (!self.conn.requestedDisconnect) {
                        throw err;
                    }
                }
            }
        });
    });
    self.conn.addListener('end', function() {
        if (self.opt.debug)
            util.log('Connection got "end" event');
    });
    self.conn.addListener('close', function() {
        if (self.opt.debug)
            util.log('Connection got "close" event');
        if (self.conn.requestedDisconnect)
            return;
        if (self.opt.debug)
            util.log('Disconnected: reconnecting');
        if (self.opt.retryCount !== null && retryCount >= self.opt.retryCount) {
            if (self.opt.debug) {
                util.log('Maximum retry count (' + self.opt.retryCount + ') reached. Aborting');
            }
            self.emit('abort', self.opt.retryCount);
            return;
        }

        if (self.opt.debug) {
            util.log('Waiting ' + self.opt.retryDelay + 'ms before retrying');
        }
        setTimeout(function() {
            self.connect(retryCount + 1);
        }, self.opt.retryDelay);
    });
    self.conn.addListener('error', function(exception) {
        self.emit('netError', exception);
        if (self.opt.debug) {
            util.log('Network error: ' + exception);
        }
    });
};
Client.prototype.disconnect = function(message, callback) {
    if (typeof (message) === 'function') {
        callback = message;
        message = undefined;
    }
    message = message || 'node-irc says goodbye';
    var self = this;
    if (self.conn.readyState == 'open') {
        var sendFunction;
        if (self.opt.floodProtection) {
            sendFunction = self._sendImmediate;
            self._clearCmdQueue();
        } else {
            sendFunction = self.send;
        }
        sendFunction.call(self, 'QUIT', message);
    }
    self.conn.requestedDisconnect = true;
    if (typeof (callback) === 'function') {
        self.conn.once('end', callback);
    }
    self.conn.end();
};

Client.prototype.send = function(command) {
    var args = Array.prototype.slice.call(arguments);

    // Note that the command arg is included in the args array as the first element

    if (args[args.length - 1].match(/\s/) || args[args.length - 1].match(/^:/) || args[args.length - 1] === '') {
        args[args.length - 1] = ':' + args[args.length - 1];
    }

    if (this.opt.debug)
        util.log('SEND: ' + args.join(' '));

    if (!this.conn.requestedDisconnect) {
        this.conn.write(args.join(' ') + '\r\n');
    }
};

Client.prototype.activateFloodProtection = function(interval) {

    var cmdQueue = [],
        safeInterval = interval || this.opt.floodProtectionDelay,
        self = this,
        origSend = this.send,
        dequeue;

    // Wrapper for the original function. Just put everything to on central
    // queue.
    this.send = function() {
        cmdQueue.push(arguments);
    };

    this._sendImmediate = function() {
        origSend.apply(self, arguments);
    };

    this._clearCmdQueue = function() {
        cmdQueue = [];
    };

    dequeue = function() {
        var args = cmdQueue.shift();
        if (args) {
            origSend.apply(self, args);
        }
    };

    // Slowly unpack the queue without flooding.
    setInterval(dequeue, safeInterval);
    dequeue();
};

Client.prototype.join = function(channel, callback) {
    var channelName =  channel.split(' ')[0];
    this.once('join' + channelName, function() {
        // if join is successful, add this channel to opts.channels
        // so that it will be re-joined upon reconnect (as channels
        // specified in options are)
        if (this.opt.channels.indexOf(channel) == -1) {
            this.opt.channels.push(channel);
        }

        if (typeof (callback) == 'function') {
            return callback.apply(this, arguments);
        }
    });
    this.send.apply(this, ['JOIN'].concat(channel.split(' ')));
};

Client.prototype.part = function(channel, message, callback) {
    if (typeof (message) === 'function') {
        callback = message;
        message = undefined;
    }
    if (typeof (callback) == 'function') {
        this.once('part' + channel, callback);
    }

    // remove this channel from this.opt.channels so we won't rejoin
    // upon reconnect
    if (this.opt.channels.indexOf(channel) != -1) {
        this.opt.channels.splice(this.opt.channels.indexOf(channel), 1);
    }

    if (message) {
        this.send('PART', channel, message);
    } else {
        this.send('PART', channel);
    }
};

Client.prototype.action = function(channel, text) {
    var self = this;
    if (typeof text !== 'undefined') {
        text.toString().split(/\r?\n/).filter(function(line) {
            return line.length > 0;
        }).forEach(function(line) {
            self.say(channel, '\u0001ACTION ' + line + '\u0001');
        });
    }
};

Client.prototype._splitLongLines = function(words, maxLength, destination) {
    if (words.length === 0) {
        return destination;
    }
    if (words.length <= maxLength) {
        destination.push(words);
        return destination;
    }
    var c = words[maxLength];
    var cutPos;
    var wsLength = 1;
    if (c.match(/\s/)) {
        cutPos = maxLength;
    } else {
        var offset = 1;
        while ((maxLength - offset) > 0) {
            c = words[maxLength - offset];
            if (c.match(/\s/)) {
                cutPos = maxLength - offset;
                break;
            }
            offset++;
        }
        if (maxLength - offset <= 0) {
            cutPos = maxLength;
            wsLength = 0;
        }
    }
    var part = words.substring(0, cutPos);
    destination.push(part);
    return this._splitLongLines(words.substring(cutPos + wsLength, words.length), maxLength, destination);
};

Client.prototype.say = function(target, text) {
    this._speak('PRIVMSG', target, text);
};

Client.prototype.notice = function(target, text) {
    this._speak('NOTICE', target, text);
};

Client.prototype._speak = function(kind, target, text) {
    var self = this;
    var maxLength = this.maxLineLength - target.length;
    if (typeof text !== 'undefined') {
        text.toString().split(/\r?\n/).filter(function(line) {
            return line.length > 0;
        }).forEach(function(line) {
            var linesToSend = self._splitLongLines(line, maxLength, []);
            linesToSend.forEach(function(toSend) {
                self.send(kind, target, toSend);
                if (kind == 'PRIVMSG') {
                    self.emit('selfMessage', target, toSend);
                }
            });
        });
    }
};

Client.prototype.whois = function(nick, callback) {
    if (typeof callback === 'function') {
        var callbackWrapper = function(info) {
            if (info.nick.toLowerCase() == nick.toLowerCase()) {
                this.removeListener('whois', callbackWrapper);
                return callback.apply(this, arguments);
            }
        };
        this.addListener('whois', callbackWrapper);
    }
    this.send('WHOIS', nick);
};

Client.prototype.list = function() {
    var args = Array.prototype.slice.call(arguments, 0);
    args.unshift('LIST');
    this.send.apply(this, args);
};

Client.prototype._addWhoisData = function(nick, key, value, onlyIfExists) {
    if (onlyIfExists && !this._whoisData[nick]) return;
    this._whoisData[nick] = this._whoisData[nick] || {nick: nick};
    this._whoisData[nick][key] = value;
};

Client.prototype._clearWhoisData = function(nick) {
    // Ensure that at least the nick exists before trying to return
    this._addWhoisData(nick, 'nick', nick);
    var data = this._whoisData[nick];
    delete this._whoisData[nick];
    return data;
};

Client.prototype._addWhoData = function(data) {
    this._who.data.push(data);
};

Client.prototype._clearWhoData = function(target) {
    var users = [], user = {},
        data = this._who.data;
    this._who.data = [];
    if (!data.length)
        return [];

    var format = this._who.queue.shift().slice(1).split('');
    var fields = _.values(_.pick(this._who.fields, format));

    if (!this.supported.whox) {
        // fix 'hops' and 'realname' getting combined into the last field in default /WHO output
        _.each(data, function(value, index) {
            data[index] = value.slice(0,6);
            data[index].push(value[6][0]);
            data[index].push(value[6].slice(2));
        });
    }

    if (fields.length != data[0].length) {
        if (this.opt.debug)
            util.log('WHO RECV: returned fields do not match requested fields');
        return [];
    }
    _.each(data, function(d) {
        user = _.object(fields, d);
        users.push(user);
    });
    return [target, users];
};

Client.prototype.who = function(target, format) {
    var sortFormat = this._who.format;
    format = format || '';
    if ( format && format != 'o' && (format[0] != '%' || !this.supported.whox) ) {
        if (this.opt.debug)
            util.log('WHO SEND: ignoring unsupported argument ' + format);
        format = '';
    }
    else if (format[0] == '%')
        format = sortFormat = '%' + _.intersection(_.keys(this._who.fields).join(''), format.slice(1)).join('');

    this._who.queue.push(sortFormat);
    if (format)
        this.send('WHO', target, format);
    else
        this.send('WHO', target);
    return sortFormat;
};

Client.prototype._addWhoDataToChan = function(target, data) {
    var users = {};
    if (!data.length)
        return false;
    if (!data[0].nick) {
        if (this.opt.debug)
            util.log('WHO CHAN: no nick field found');
        return false;
    }
    _.each(data, function(user) {
        var nick = user.nick;
        if (user.status) {
            var status = user.status.split('');
            user.away  = (status.shift() == 'G');
            if (status.length)
                user.modes = status;
        }
        if (user.account)
            user.isRegistered = false;
            if (user.account === '0')
                delete user.account;
            else
                user.isRegistered = true;

        users[nick] = _.pick(user, ['username', 'host', 'away', 'modes', 'account', 'isRegistered']);
    });
    if (this.chanData(target)) {
        var channel = target;
        this.chans[channel].users = users;
        var syncStart = this.syncChans[channel];
        if (syncStart) {
            delete this.syncChans[channel];
            var syncEnd = _.now();
            var syncTime = (syncEnd - syncStart) / 1000; // secs.ms
            this.emit('joinsync', channel, syncTime);
            this.emit('joinsync' + channel, syncTime);
            if (this.opt.debug)
                util.log('Channel data synced in ' + syncTime + ' seconds');
        }
    } else {
        _.each(users, function(data, nick) {
            _.each(this.nickInChannels(nick), function(chan) {
                user = this.chans[chan].users[nick];
                user = _.extend(user, _.omit(data, 'modes'));
            });
        }, this);
    }
};

// Complain if things are not found
Client.prototype._unknown = function(data, label, unknown) {
    if (data === undefined) {
        if (this.opt.debug)
            util.log('In ' + callerId.getData().functionName + '(): unknown ' + label + ': ' + unknown);
        return true;
    }
    return false;
};


Client.prototype._addJoinDataToChan = function(channel, message) {
    if (channel && channel.users) {
        var user = {
            username: message.user,
            host:     message.host,
        };
        if (_.contains(this.capabilities, 'extended-join')) {
            user.isRegistered = (message.args[1] != '*');
            if (user.isRegistered)
                user.account = message.args[1];
        }
        channel.users[message.nick] = user;
    }

};

Client.prototype._updateNickAccount = function(nick, account) {
    var data = {};
    data.isRegistered = (account != '*');
    if (data.isRegistered)
        data.account = account;
    _.each(this.chans, function(cdata, chan) {
        if (_.has(cdata.users, nick))
            this.chans[chan].users[nick] = _.extend(cdata.users[nick], data);
    }, this);
};

// Test for mode on user
Client.prototype.userHasChanMode = function(user, mode) {
    var modePrefix = this.prefixForMode[mode];
    if (this._unknown(modePrefix, 'mode', mode)) return false;
    return ( user.modes && _.contains(user.modes, modePrefix) );
};

// Test for modes on nick
Client.prototype.nickHasChanMode = function(nick, mode, channel) {
    var chan = this.chanData(channel);
    if (this._unknown(chan, 'channel', channel)) return false;
    var user = chan.users[nick];
    if (this._unknown(user, 'nick', nick)) return false;
    return this.userHasChanMode(user, mode);
};
Client.prototype.nickHasVoice = function(nick, channel) {
    return this.nickHasChanMode(nick, 'v', channel);
};
Client.prototype.nickHasOp = function(nick, channel) {
    return this.nickHasChanMode(nick, 'o', channel);
};

// Test for modes on self
Client.prototype.haveChanMode = function(mode, channel) {
    return this.nickHasChanMode(this.nick, mode, channel);
};
Client.prototype.haveVoice = function(channel) {
    return this.haveChanMode('v', channel);
};
Client.prototype.haveOp = function(channel) {
    return this.haveChanMode('o', channel);
};

// Get collection of users who have mode
Client.prototype.usersWithChanmode = function(mode, channel) {
    var modePrefix = this.prefixForMode[mode];
    var chan       = this.chanData(channel);
    if (this._unknown(modePrefix, 'mode', mode)) return {};
    if (this._unknown(chan, 'channel', channel)) return {};
    var modeUsers = _.pick(chan.users, function(user) {
        return ( user.modes && _.contains(user.modes, modePrefix) );
    });
    return modeUsers;
};
Client.prototype.usersWithVoice = function(channel) {
    return this.usersWithChanmode('v', channel);
};
Client.prototype.usersWithOp = function(channel) {
    return this.usersWithChanmode('o', channel);
};

// Get list of nicks who have mode
Client.prototype.nicksWithChanmode = function(mode, channel) {
    return _.keys(this.usersWithChanmode(mode, channel));
};
Client.prototype.nicksWithVoice = function(channel) {
    return _.keys(this.usersWithVoice(channel));
};
Client.prototype.nicksWithOp = function(channel) {
    return _.keys(this.usersWithOp(channel));
};

/**
 * Get list of nicks in channel
 * @param {string}        channel       - Channel to query
 * @param {string|Array} [withoutModes] - Return nicks without these channel modes (OR)
 * @param {boolean}      [combined]     - Return nicks without all of withoutModes (AND)
 */
Client.prototype.nicksInChannel = function(channel, withoutModes, combined) {
    var self = this;
    var chan = self.chanData(channel);
    if (self._unknown(chan, 'channel', channel)) return [];
    var filterFunc = function() { return true; };

    if (typeof withoutModes == 'string')
        withoutModes = withoutModes.split('');

    if (withoutModes && withoutModes.length) {
        var checkForMode = function(mode) { return !userHasChanMode(user, mode); };
        filterFunc = function(user) {
            return (combined) ? _.every(withoutModes, checkForMode)
                              :  _.some(withoutModes, checkForMode);
        };
    }
    return _.chain(chan.users)
                .pick(filterFunc)
                .keys()
                .value();
};

Client.prototype.nickInChannels = function(nick, remove) {
    var self = this, channels = [];
    _.each(_.keys(self.chans), function(channel) {
        if (self.nickIsInChannel(nick, channel, remove))
            channels.push(channel);
    });
    return channels;
};

Client.prototype.nickIsInChannel = function(nick, channel, remove) {
    var chan = this.chanData(channel);
    if (this._unknown(chan, 'channel', channel)) return false;
    var user = chan.users[nick];
    if (user) {
        if (remove !== undefined)
            delete chan.users[nick];
        return true;
    }
    return false;
};

// Get user object(s) by nickname
// If nicks is a list, users is a collection keyed by nick
// If channel is not set, search all channels and return a collection keyed by channel
Client.prototype.nickToUser = function(nicks, channel) {
    var channels = {}, data = {};
    if (channel) {
        var chan = this.chanData(channel);
        if (this._unknown(chan, 'channel', channel)) return {};
        channels[channel] = chan;
    }
    else
        channels = this.chans;

    _.each(channels, function(chan, key) {
        var chanData = _.pick(chan.users, nicks);
        if (typeof nicks == 'string') // nicks is actually a single nick
            chanData = chanData[nicks];
        data[key] = chanData;
    }, this);
    return (channel) ? data[channel] : data;
};

Client.prototype.setChanMode = function(channel, mode, nicks) {
    var self = this;
    if (!self.haveOp(channel)) {
        if (self.opt.debug)
            util.log('In Client.setChanMode(): not opped so can\'t set modes');
        return false;
    }
    var chan = self.chanData(channel);
    if (self._unknown(chan, 'channel', channel)) return false;
    var addsub = mode[0];
    mode = mode[1];
    if ( !_.contains(['+', '-'], addsub) || !self.prefixForMode[mode] ) {
        self._unknown(undefined, 'mode', addsub + mode);
        return false;
    }
    var filterFunc = function(user) { return !self.userHasChanMode(user, mode); };
    if (addsub == '-')
        filterFunc = _.negate(filterFunc);
    if (typeof nicks == 'string')
        nicks = nicks.split(' ');
    nicks = _.chain(self.nickToUser(nicks, channel))
                .pick(filterFunc)
                .keys()
                .value();
    if (nicks.length)
        nicks = self._chunk(nicks, self.supported.modes); // number of modes allowed per line
    else
        return false;
    _.each(nicks, function(batch) {
        var modes = addsub + new Array(batch.length + 1).join(mode);
        var args = ['MODE', channel, modes].concat(batch);
        if (self.opt.debug)
            util.log('Sending ' + args.join(' '));
        self.send.apply(self, args);
    });
    return true;
};

// Split array into chunks of max length n
Client.prototype._chunk = function(list, n) {
    var chunked = _.chain(list)
                    .groupBy(function(el, i) { return Math.floor(i / n); })
                    .toArray()
                    .value();
    return chunked;
};

Client.prototype._handleCTCP = function(from, to, text, type, message) {
    text = text.slice(1);
    text = text.slice(0, text.indexOf('\u0001'));
    var parts = text.split(' ');
    this.emit('ctcp', from, to, text, type, message);
    this.emit('ctcp-' + type, from, to, text, message);
    if (type === 'privmsg' && text === 'VERSION')
        this.emit('ctcp-version', from, to, message);
    if (parts[0] === 'ACTION' && parts.length > 1)
        this.emit('action', from, to, parts.slice(1).join(' '), message);
    if (parts[0] === 'PING' && type === 'privmsg' && parts.length > 1)
        this.ctcp(from, 'notice', text);
};

Client.prototype.ctcp = function(to, type, text) {
    return this[type === 'privmsg' ? 'say' : 'notice'](to, '\u0001' + text + '\u0001');
};

Client.prototype.convertEncoding = function(str) {
    var self = this, out = str;

    if (self.opt.encoding) {
        try {
            var charsetDetector = require('node-icu-charset-detector');
            var Iconv = require('iconv').Iconv;
            var charset = charsetDetector.detectCharset(str);
            var converter = new Iconv(charset.toString(), self.opt.encoding);

            out = converter.convert(str);
        } catch (err) {
            if (self.opt.debug) {
                util.log('\u001b[01;31mERROR: ' + err + '\u001b[0m');
                util.inspect({ str: str, charset: charset });
            }
        }
    }

    return out;
};
// blatantly stolen from irssi's splitlong.pl. Thanks, Bjoern Krombholz!
Client.prototype._updateMaxLineLength = function() {
    // 497 = 510 - (":" + "!" + " PRIVMSG " + " :").length;
    // target is determined in _speak() and subtracted there
    this.maxLineLength = 497 - this.nick.length - this.hostMask.length;
};
