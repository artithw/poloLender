"use strict";

var _ = require('lodash');
var Big = require ("big.js");
var moment = require("moment");
var async = require ("async");
var debug = require("debug")("pololender");
var Bitfinex = require("bitfinex");
var Poloniex = require("./poloniex.js");
var srv = require ("../../core/srv");


var PoloLender = function(name) {
	var self = this;
	self.me = name;

	var logger = srv.logger;
	var io = srv.io;
	var poloPrivate;
	var socket;

	var currencies = ["BTC", "ETH"];

	var status = {
		restarted: Date.now(),
		activeLoansCount: 0,
		count: 0,
		lastRun: {
			report: moment(0)
		},
		wmr: {}
	};
	var anyCanceledOffer,
		anyNewLoans = {};
	var activeLoans = [],
		completedLoans = [],
		activeOffers = {},
		anyChangedLoans = {},
		availableFunds = {}, // available funds from balance
		depositFunds = {},      // available funds from balance
		ev, val;

	var advisorInfo = {};

	var configDefault = {
		startDate: "",		
		reportEveryMinutes: 5,
		minOrderSize: "0.001",
		startBalance: {},
		restartTime: moment(),
		offerMaxAmount: {},
		advisor: "safe-hollows.crypto.zone"
	};
	var config = {};

	_.assign(config, configDefault);

	var bfxPublic = new Bitfinex();

	var setConfig = function () {
		advisorInfo.time = "";
		currencies.forEach(function (c, index, array) {
		advisorInfo[c] = {
			bestReturnRate: "0.05",
			bestDuration: "60",
			averageLoanHoldingTime: ""
		}
		});
		// API keys
		try {
			ev = self.me.toUpperCase() + "_APIKEY";
			var apiKey = JSON.parse(process.env[ev]);
			self.apiKey = {
				key: apiKey.key || "",
				secret: apiKey.secret || "secret"
			};
		}
		catch (err) {
			self.apiKey  = {
				key: "",
				secret: ""
			};
			logger.alert(`${self.me}: Environment variable ${ev}  is invalid. Please see documentation at https://github.com/dutu/poloLender/`);
			debug(`${ev}=${process.env[ev]}`);
			logger.alert(`${self.me}: Application will now exit. Correct the environment variable ${ev} and start the application again`);
			process.exit(1);
		}

/*
		ev = self.me.toUpperCase() + "_ADVISOR";
		config.advisor = process.env[ev];
		if (!config.advisor) {
			logger.error(`${self.me}: Environment variable ${ev} is invalid. Please see documentation at https://github.com/dutu/poloLender/`);
			config.advisor = configDefault.advisor
		}
		logger.info(`${self.me}: Using ${ev}=${config.advisor}`);
*/

		try {
			ev = self.me.toUpperCase() + "_REPORTINTERVAL";
			val = parseFloat(process.env[ev]);
			if(!_.isNumber()) {
				throw val;
			}
		}
		catch (err) {
			logger.error(`${self.me}: Environment variable ${ev} is invalid (should be a number). Please see documentation at https://github.com/dutu/poloLender/`);
			debug(`${ev}=${process.env[ev]}`);
			config.reportEveryMinutes = configDefault.reportEveryMinutes;
		}
		logger.info(`${self.me}: Using ${ev}=${config.reportEveryMinutes}`);

		try {
			ev = self.me.toUpperCase() + "_STARTDATE";
			config.startDate = moment(process.env[ev]);
		} catch (err) {
			logger.error(`${self.me}: Environment variable ${ev} is invalid (should be a date). Please see documentation at https://github.com/dutu/poloLender/`);
			config.startDate = configDefault.startDate;
			debug(`${ev}=${process.env[ev]}`);

		}
		logger.info(`${self.me}: Using ${ev}=${config.startDate}`);

		try {
			ev = self.me.toUpperCase() + "_STARTBALANCE";
			var startBalance = JSON.parse(process.env[ev]);
		} catch (err) {
			logger.error(`${self.me}: Environment variable ${ev} is invalid. Please see documentation at https://github.com/dutu/poloLender/`);
			debug(`${ev}=${process.env[ev]}`);
		}
		currencies.forEach(function (c, index, array) {
			if(startBalance && startBalance.hasOwnProperty(c)) {
				try {
					val = parseFloat(startBalance[c]);
					if(!_.isNumber()) {
						throw val;
					} else {
						config.startBalance[c] = val.toString();
					}
				} catch (err) {
					config.startBalance[c] = "0";
					logger.error(`${self.me}: Environment variable ${ev} is invalid. Please see documentation at https://github.com/dutu/poloLender/`);
					debug(`${ev}=${process.env[ev]}`);
				}
			}
			else {
				config.startBalance[c] = "0";
			}
		});
		val = JSON.stringify(config.startBalance);
		logger.info(`${self.me}: Using ${ev}=${val}`);

		try {
			ev = self.me.toUpperCase() + "_LENDMAX";
			var lendMax = JSON.parse(process.env[ev]);
		} catch (err) {
			logger.error(`${self.me}: Environment variable ${ev} is invalid. Please see documentation at https://github.com/dutu/poloLender/`);
			debug(`${ev}=${process.env[ev]}`);
		}
		currencies.forEach(function (c, index, array) {
			if(lendMax && lendMax.hasOwnProperty(c)) {
				try {
					val = parseFloat(lendMax[c]);
					if(!_.isNumber()) {
						throw val;
					} else {
						config.offerMaxAmount[c] = val.toString();
					}
				} catch (err) {
					config.offerMaxAmount[c] = "999999";
					logger.error(`${self.me}: Environment variable ${ev} is invalid. Please see documentation at https://github.com/dutu/poloLender/`);
					debug(`${ev}=${process.env[ev]}`);
				}
			}
			else {
				config.offerMaxAmount[c] = "999999";
			}
		});
		val = JSON.stringify(config.startBalance);
		logger.info(`${self.me}: Using ${ev}=${val}`);

		try {
			ev = self.me.toUpperCase() + "_STARTTIME";
			config.restartTime = moment(process.env[ev]);
		} catch (err) {
			logger.error(`${self.me}: Environment variable ${ev} is invalid. Please see documentation at https://github.com/dutu/poloLender/`);
			debug(`${ev}=${process.env[ev]}`);
			config.restartTime = moment(0);
		}
		val = config.restartTime.utc().format();
		logger.info(`${self.me}: Using ${ev}=${val}`);
	};

	var strAR = function (str, length) {
		if (str.length > length)
			return str;
		var result = "                             " + str;
		result = result.substring(result.length - length);
		return result
	};

	var msgRate = function(perDayProc) {
		var perDay, perYear, perMonth, msg;
		perDay = new Big(perDayProc).times(100).toFixed(6);
		perYear = new Big(perDayProc).times(365*100).toFixed(4);
//		perMonth = new Big(perYear).div(12).toFixed(4);
		msg = strAR(perDay, 6) + "%";
		msg += " (" + strAR(new Big(perYear).toFixed(2), 5) + "%)";
		return msg;
	};

	var execTrade = function() {

		var msgLoanReturned = function (element){
			var canceledAC, createdAt, created, msg,holdingTimeSeconds;
			createdAt = moment.utc(element.date);
			created = createdAt.fromNow();
			canceledAC = {
				id: element.id,
				currency: element.currency,
				amount: strAR(new Big(element.amount).toFixed(8), 14),
				rate: new Big(element.rate).toFixed(8),
				period: element.period,
				createdAt: createdAt,
				expires: ""
			};
			var holdingTimeInSeconds = moment().diff(createdAt, "seconds");
			var htHours = Math.floor(holdingTimeInSeconds / 60 /60);
			var htMin = Math.floor((holdingTimeInSeconds - htHours * 60 *60) / 60);
			var htSec = holdingTimeInSeconds - htHours * 60 *60 - htMin * 60;
			var msgHt = `${htHours}h ${htMin}m ${htSec}s`;
			msg = "Loan returned #" + canceledAC.id + " " + canceledAC.currency + " " + canceledAC.amount + " at " + msgRate(canceledAC.rate) + `, holding time: ${msgHt}`;
			logger.info(self.me, msg);
		};

		var msgNewCredit = function (element){
			var newAC, createdAt, expiresAt, expires, msg;
			createdAt = moment.utc(element.date);
			expiresAt = moment.utc(element.date).add(element.duration, "days");
			expires = expiresAt.fromNow();
			newAC = {
				id: element.id,
				currency: element.currency,
				amount: strAR(new Big(element.amount).toFixed(8), 14),
				rate: strAR(new Big(element.rate) .toFixed(8), 7),
				period: element.duration,
				createdAt: createdAt,
				expires: expires
			};
			msg = "Loan taken    #" + newAC.id + " " + newAC.currency + " " + newAC.amount + " at " + msgRate(newAC.rate) + ", created " + newAC.createdAt.utcOffset(120).format("YYYY-MM-DD HH:mm");
			msg += ", expires " + expires;
			logger.info(self.me, msg);
		};

		var updateActiveLoans = function(callback) {
			var updateWithNewActiveLoans = function (newActiveLoans) {
				var found;
				var dateNow = Date.now();
				activeLoans.forEach(function (element, index, array) {
					found = _.find(newActiveLoans, {id: element.id});
					if (typeof found === "undefined") {
						var returnedLoan = {
							"id": element.id,
							"date": moment.utc(element.date).toDate(),
							"currency": element.currency,
							"rate": element.rate,
							"duration": element.duration,
							"returned": dateNow
						};
						msgLoanReturned(element);
						anyChangedLoans[element.currency] = true;
					}
				});
				newActiveLoans.forEach(function (element, index, array) {
					found = _.find(activeLoans, {id: element.id});
					if (typeof found === "undefined") {
						msgNewCredit(element);
						anyChangedLoans[element.currency] = true;
						anyNewLoans[element.currency] = true;
						status.activeLoansCount++;
					}
				});
				activeLoans = newActiveLoans;

				var currenciesNewActiveLoans = [];
				newActiveLoans.forEach(function (element, index, array) {
					currenciesNewActiveLoans.push(element.currency)
				});
				currenciesNewActiveLoans = _.uniq(currenciesNewActiveLoans);
			};

			poloPrivate.returnActiveLoans(function (err, result) {
				var newActiveLoans;
				if (err || result.error) {
					err = err || new Error(result.error);
					logger.notice(self.me, "returnActiveLoans: " + err.message);
					return callback(err);
				}
				newActiveLoans = result.hasOwnProperty("provided") ? result.provided : [];
				updateWithNewActiveLoans(newActiveLoans);
				// update wmr
				currencies.forEach(function (c, index, array) {
					var sum = new Big(0),
						sumOfProd = new Big(0);
					activeLoans.forEach(function (element, index, array) {
						if (element.currency.toUpperCase() === c.toUpperCase()) {
							sum = sum.plus(element.amount);
							sumOfProd = sumOfProd.plus(new Big(element.amount).times(element.rate));
						}
					});
					status.wmr[c] = sum.eq(0) ? "0" : sumOfProd.div(sum).toFixed(8);
				});
				callback(null);
			});
		};

		var updateActiveOffers = function(callback) {
			poloPrivate.returnOpenLoanOffers(function (err, result) {
				if (err || result.error) {
					err = err || new Error(result.error);
					logger.notice(self.me, "returnOpenLoanOffers: " + err.message);
					return callback(err);
				}
				currencies.forEach(function (c, i, a) {
					var newActiveOffers;
					newActiveOffers = typeof result[c] !== "undefined" ? result[c] : [];
					var found,
						newOffers = false;
					newActiveOffers.forEach(function (element, index, array) {
						found = _.find(activeOffers[c], {id: element.id});
						if (typeof found === "undefined") {
							newOffers = true;
						}
					});
					activeOffers[c] = newActiveOffers;
					if (newOffers) {
					}
				});
				callback(null);
			});
		};

		var updateAvailableFunds = function(callback) {
			poloPrivate.returnAvailableAccountBalances("lending", function (err, result) {
				if (err || result.error) {
					err = err || new Error(result.error);
					logger.notice(self.me, "returnAvailableAccountBalances: " + err.message);
					return callback(err);
				}
				currencies.forEach(function (c, i, a) {
					availableFunds[c] = result.hasOwnProperty("lending") && result.lending.hasOwnProperty(c) ? result.lending[c] : "0";
				});
				callback(null);
			});
		};

		var cancelHighOffers = function (callback) {
			async.forEachOfSeries(activeOffers,
				// for each currency in activeOffers
				function(activeOffersOneCurrency, currency, callback) {
					async.forEachOfSeries(activeOffersOneCurrency,
						//for each offer in the array (for respective currency)
						function (offer, index, cb) {
							var msg, offerRate;
							var amountTrading;

							offerRate = new Big(offer.rate);
							if (offerRate.eq(advisorInfo[currency].bestReturnRate)){
								// lend offers is on correct price
								return cb(null);
							}

							if (!(config.offerMaxAmount[currency] == "")) {
								// only if we are reserving any amount check if we are already trading more then offerMaxAmount
								amountTrading = new Big(depositFunds[currency]).minus(availableFunds[currency]);
								if(amountTrading.gte(config.offerMaxAmount[currency])) {
									// we are already trading higher then offerMaxAmount
									return cb(null);
								}
							}
							if (process.env[self.me+"_NOTRADE"] === "true") {
								logger.notice(self.me, "cancelHighOffers: NO TRADE");
								return cb(null);
							}
							poloPrivate.cancelLoanOffer(offer.id.toString(), function (err, result) {
								if (err || result.error) {
									err = err || new Error(result.error);
									logger.notice(self.me, `cancelLoanOffer: ${err.message} (#${offer.id})`);
									return cb(err);
								}
								anyCanceledOffer  = true;
								msg = "OfferCanceled #" + offer.id;
								msg += " " + currency.toUpperCase() + " " + strAR(new Big(offer.amount).toFixed(8), 14);
								msg += " at " + msgRate(offer.rate);
								msg += ", brr " + msgRate(advisorInfo[currency].bestReturnRate);
								logger.info(self.me, msg);
								return cb(null);
							});
						},
						function (err) {
							callback(err);
						});
				},
				function (err){
					callback(err);
				});
		};

		var postOffers = function (callback) {
			async.forEachOfSeries(currencies,
				// for each currency
				function(currency, index, callback) {
					var amountTrading, amountToTrade, amount, amountMaxToTrade,
						duration, autoRenew, lendingRate;

					if (config.offerMaxAmount[currency] == "") {
						amountToTrade = new Big(availableFunds[currency]);       // we are not reserving any funds
					}
					else {
						amountTrading = new Big(depositFunds[currency]).minus(availableFunds[currency]);
						amountMaxToTrade = new Big(config.offerMaxAmount[currency]).minus(amountTrading);

						if (new Big(availableFunds[currency]).lt(amountMaxToTrade)) {
							amountToTrade = new Big(availableFunds[currency]);
						} else {
							amountToTrade = amountMaxToTrade;
						}
					}

					if (amountToTrade.lt(config.minOrderSize)) {
//			    logger.info(self.me, "Offer not posted: Available " + currency + " " + amountToTrade + ", minimum order size is USD " + config.minOrderSize);
						return callback(null);
					}

					/*		if (amountMaxToTrade.isNegative()) {
					 logger.info(self.me, "Offer not posted: Currently trading " + currency + " " + amountTrading.toString() + ", maximum allowed is " + currency + " " + config.offerMax[currency]);
					 return callback(null);
					 }
					 */

					if (process.env[self.me+"_NOTRADE"] === "true") {
						logger.notice(self.me, "Post offer: NO TRADE");
						return callback(new Error("NO TRADE"));
					}

					amount = amountToTrade.toFixed(8);
					lendingRate = advisorInfo[currency].bestReturnRate;
					duration = advisorInfo[currency].bestDuration;
					autoRenew = "0";

					poloPrivate.createLoanOffer(currency, amount, duration, autoRenew, lendingRate, function (err, result) {
						if (err || result.error) {
							err = err || new Error(result.error);
							logger.notice(self.me, "createLoanOffer: " + err.message);
							return callback(err);
						}
						status.offersCount++;
						var newAO = {
							id: result.orderID,
							currency: currency,
							amount: strAR(new Big(amount).toFixed(8), 14),
							rate: strAR(new Big(lendingRate).toFixed(8), 7),
							period: duration
						};
						var msg = `Loan offered  #${newAO.id} ${newAO.currency} ${newAO.amount} at ` + msgRate(newAO.rate) + `, duration ${newAO.period} days`;
						logger.info(self.me, msg);
						callback(null);
					});
				},
				function (err){
					callback(err);
				});
		};

		var report = function() {
			// execute every x minutes
			var now = moment();
			var duration = now.diff(status.lastRun.report, "minutes");
			if (duration < config.reportEveryMinutes) {
				return;
			}
			var speed = new Big(status.lastRun.speedCount).div(duration).toFixed(2);
			status.lastRun.report = now;
			status.lastRun.speedCount = 0;

			var msg, since;
			status.offersCount = status.offersCount || status.activeLoansCount;

			// since = startDate.fromNow(true);
			since = now.diff(config.startDate, "days");
			msg = "--- xBot running for "+ since + " days • restarted " + self.started.fromNow() + " (" + self.started.utcOffset(120).format("YYYY-MM-DD HH:mm") + ")";
			msg += "--- Offers made/Loans taken: " + status.offersCount + "/" + status.activeLoansCount + " ";
			msg += `, speed: ${speed}/min`;
			msg += "---------------------------------------------------------------------------------------------------------".slice(msg.length);
			logger.notice(`${self.me}: ${msg}`);

			currencies.forEach(function (c, index, array) {
				var profit = new Big(depositFunds[c]).minus(config.startBalance[c]);
				var minutes = now.diff(config.restartTime, "minutes", true);
				var activeLoansCount = 0;
				var activeLoansAmount = new Big(0);
				activeLoans.forEach(function (l, index, array) {
					if (l.currency === c) {
						activeLoansCount++;
						activeLoansAmount = activeLoansAmount.plus(l.amount);
					}
				});
				var reserved, offerMax, available;
				try {
					offerMax = parseFloat(config.offerMaxAmount[c]);
					if (parseFloat(depositFunds[c]) < offerMax) {
						reserved = "0";
						available = availableFunds[c]
					}
					else {
						reserved = new Big(depositFunds[c]).minus(offerMax).toFixed(8);
						available = new Big(availableFunds[c]).minus(reserved).toFixed(8);
					}
				}
				catch (err) {
					reserved = "0";
					available = availableFunds[c];
				}
				bfxPublic.ticker("btcusd", function (err, result) {
					if(err) {
						logger.notice(self.me, "bfxPublic.ticker: " + err.message);
						return;
					}
					var rateBTCUSD = new Big(result.last_price).toString();
					msg = `* ${c}: ${activeLoansCount} loans: ${activeLoansAmount}, res: ${reserved} ● TOTAL: ${depositFunds[c]}, `;
					//msg += `Start: ${journalEntry.balance[c]}, `
					msg += ` ● PROFIT: ${c} ${profit.toFixed(8)} (${profit.div(minutes).times(60*24).toFixed(3)}/day)`;
					if(c === "BTC")
						msg += ` ≈ USD: ${profit.times(rateBTCUSD).toFixed(2)} (${profit.times(rateBTCUSD).div(minutes).times(60*24).toFixed(2)}/day)`;
					var wmrMsg = msgRate(status.wmr[c]);
					var ewmr =  msgRate(new Big(status.wmr[c]).times(0.85).toFixed(8));
					msg += ` ● wmr: ${wmrMsg} ewmr: ${ewmr} ● alht: ${advisorInfo[c].averageLoanHoldingTime}`;
					logger.notice(self.me, msg);
				});
			});
		};

		async.series({
				updateActiveLoans: function(callback){
					updateActiveLoans(function (err) {
						callback(err, err && err.message || "OK");
					});
				},
				updateActiveOffers: function(callback) {
					updateActiveOffers(function (err) {
						callback(err, err && err.message || "OK");
					});
				},
				updateBalances: function(callback) {
					updateAvailableFunds(function (err) {
						currencies.forEach(function (c, index, array) {
							var amountActiveOffers = new Big(0);
							var amountActiveLoans = new Big(0);
							if (_.isArray(activeOffers[c]))
								activeOffers[c].forEach(function (o, index, array) {
									amountActiveOffers = amountActiveOffers.plus(o.amount);
								});
							activeLoans.forEach(function (l, index, array) {
								if (l.currency == c)
									amountActiveLoans = amountActiveLoans.plus(l.amount);
							});
							depositFunds[c] = amountActiveOffers.plus(amountActiveLoans).plus(availableFunds[c]).toFixed(8);
						});
						callback(err, err && err.message || "OK");
					});
				},
				report: function (callback) {
					report();
					callback(null, "OK");
				},
				cancelHighOffers: function(callback) {          // cancel offers if price is too high
					cancelHighOffers(function (err){
						callback(err, err && err.message || "OK");
					});
				},
				updateAvailableFunds: function(callback) {
					if (!anyCanceledOffer)
						return callback(null, "OK");
					updateAvailableFunds(function (err) {
						anyCanceledOffer = false;
						callback(err, err && err.message || "OK");
					});
				},
				postOffers: function(callback) {
					postOffers(function (err){
						callback(err, err && err.message || "OK");
					});
				}
			},
			function(err, results) {
				status.lastRun.speedCount++;
				var timeout = 300;
				setTimeout(execTrade, timeout);
			});
	};

	self.start = function() {
		status.lastRun.speedCount= 0;
		self.started = moment();
		setConfig();
		poloPrivate = new Poloniex(self.apiKey.key, self.apiKey.secret);

		socket = require('socket.io-client')(`http://${config.advisor}/`);
		socket.on('connect', function () {
			logger.info(`${self.me}: Connected to server ${config.advisor}`);
		});
		socket.on('reconnect', function () {
			logger.info(`${self.me}: Reconnected to server ${config.advisor}`);
		});
		socket.on("connect_error", function (err) {
			logger.warning(`${self.me}: Error connecting to server ${config.advisor} (${err.type}: ${err.message})`);
		});
		socket.on("reconnect_error", function (err) {
			logger.warning(`${self.me}: Error reconnecting to server ${config.advisor} (${err.type}: ${err.message})`);
		});
		socket.on("disconnect", function () {
			logger.notice(`${self.me}: Disconnected from server ${config.advisor}`);
		});
		socket.on("reconnecting", function (attemptNumber) {
			logger.info(`${self.me}: Reconnecting to server ${config.advisor} (${attemptNumber})`);
		});
		socket.on("send:loanOfferParameters", function (msg) {
			var smsg = JSON.stringify(msg);
			debug(`received send:loanOfferParameters = ${smsg}`);
			var loanOfferParameters;
			try {
				advisorInfo.time = msg.time;
				delete msg.time;
				_.forOwn(msg, function(value, key) {
					advisorInfo[key] = {
						averageLoanHoldingTime: value.averageLoanHoldingTime,
						bestReturnRate: value.bestReturnRate,
						bestDuration: value.bestDuration
					}
				});
			}
			catch (error) {
				logger.error(`${self.me}: Cannot parse loanOfferParameters ${smsg}`);
				debug(`Cannot parse loanOfferParameters: ${error.message}`);
			}
		});
		setTimeout(execTrade, 1);
	};

	self.stop = function() {
	};
};

module.exports = PoloLender;