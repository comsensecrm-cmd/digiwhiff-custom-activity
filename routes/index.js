'use strict';

exports.index = function (req, res) {
    res.sendFile('index.html', { root: require('path').join(__dirname, '..', 'public') });
};

exports.login = function (req, res) {
    res.redirect('/');
};

exports.logout = function (req, res) {
    res.status(200).send('Logged out');
};