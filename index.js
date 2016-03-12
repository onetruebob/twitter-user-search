"use strict"

let Twitter = require('twitter')
let client = new Twitter(require('./twitterSecrets.json'))
let Rx = require('rx')
let fs = require('fs')
let searchTermObservable = Rx.Observable.from(require('./searchTerms.json'))

const pagesPerQuery = 50 //Only allowed 1000 results and 20 results per page per query
const apiResetTime = 16 * 60 * 1000 //16 minutes in milliseconds

let usersFound = {}
let userResults = []

let totalUserCount = 0
let failedDescriptionCount = 0
let dupUserCount = 0
let foundCount = 0

let hackEquals = (obj1, obj2) => JSON.stringify(obj1) === JSON.stringify(obj2)

let getSearchFromServer = (searchTerm, page) => {
    return Rx.Observable.create((obs) => {
        let params = {
            q: searchTerm,
            count: 20,
            page: page
        }

        client.get('users/search', params, (error, users) => {
            if (error) {
                obs.onError(error)
            } else {
                obs.onNext(users)
            }
            obs.onCompleted()
        });
    })
}


let getAllSearchPages = (searchTerm) => {
    console.log(`Starting search for: ${searchTerm}`);
    return Rx.Observable.create((obs) => {
        let disposable = new Rx.SerialDisposable()
        let previousUsers = []

        let recur = (page) => {
            disposable.setDisposable(
                getSearchFromServer(searchTerm, page)
                .subscribe((results) => {
                    results.forEach((user) => obs.onNext(user))

                    if (hackEquals(results, previousUsers) || page > pagesPerQuery) {
                        obs.onCompleted()
                    } else {
                        previousUsers = results;
                        recur(page + 1);
                    }
                },
                (error) => {
                    if (error[0] && error[0].code == 88) {
                        console.log('At search limit. Resuming search in 16 minutes');
                        setTimeout(() => recur(page), apiResetTime) // Over search limit. Keep trying after 16 mins.
                    } else {
                        console.log('Got error:', error, '. Retrying.')
                        recur(page)
                    }
                })
                )
        }

        recur(1)

        return disposable
    })
}

// let getAllUsersFromSearchTerm = (searchTerm) => getAllSearchPages(searchTerm)
//     .reduce((accUsers, newUsers) => accUsers.concat(newUsers), [])

let getAllUsersFromSearchTerm = (searchTerm) => {
    let users = [];
    return Rx.Observable.create((obs) => {
        getAllSearchPages(searchTerm).subscribe(
            (user) => users.push(user),
            (error) => obs.onError(error),
            () => {
                obs.onNext(users)
                obs.onCompleted()
            }
            )
    })
}

let userIsValid = (searchTerm) => {
    return (user) => {
        totalUserCount++;

        let lowerDescription = user.description && user.description.toLowerCase();
        let lowerName = user.name && user.name.toLowerCase();

        if(!(lowerDescription.includes(searchTerm) || lowerName.includes(searchTerm))) {
            failedDescriptionCount++;
            return false;
        }

        if (usersFound[user.screen_name]) {
            dupUserCount++;
            return false;
        }

        usersFound[user.screen_name] = true;
        foundCount++;
        return true;
    }
};

let searchUsersQuery = searchTermObservable
    .concatMap((searchTerm) => getAllUsersFromSearchTerm(searchTerm), (searchTerm, users) => ({searchTerm, users}))
    .map((results) => {
        let searchTerm = results.searchTerm
        let users = results.users
        return { searchTerm, users: users.filter(userIsValid(searchTerm))}
    })
    .map((results) => {
        let searchTerm = results.searchTerm
        let users = results.users

        return {
            searchTerm,
            users: users.map((user) => ({
                'handle': user.screen_name,
                'name': user.name,
                'description': user.description,
                'followers': user.followers_count,
                'following': user.friends_count,
                'lastTweetDate': user.status && user.status.created_at
            }))
        }
    })

searchUsersQuery
    .subscribe(
        (result) => {
            let searchTerm = result.searchTerm
            let users = result.users
            console.log(`Completed search for ${searchTerm}. Found ${users.length} new users.`)
            // console.log(`Completed search for ${searchTerm}. Found ${users.screen_name} new users.`)
            userResults = userResults.concat(users)

            fs.writeFile('search-results.json', JSON.stringify(userResults), () => console.log(`results written for ${searchTerm}`))

            fs.writeFile('lastSearchProcessed.json', JSON.stringify({
                searchTerm,
                totalUsersProcessed: totalUserCount,
                failedDescriptionCount: failedDescriptionCount,
                dupUserCount: dupUserCount,
                usersFound: userResults.length
            }), () => console.log(`index written for ${searchTerm}`))
        },
        (error) => console.log('Error:', error),
        () => console.log('Search completed')
    )