'use strict';
// Explicit modular entry points supported by Firebase Admin 14.
const {initializeApp,cert}=require('firebase-admin/app');
const {getAuth}=require('firebase-admin/auth');
const {getDatabase}=require('firebase-admin/database');
const {getMessaging}=require('firebase-admin/messaging');
module.exports={initializeApp,credential:{cert},auth:getAuth,database:getDatabase,messaging:getMessaging};
