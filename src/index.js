import Proto from 'uberproto';
import filter from 'feathers-query-filters';
import { types as errors } from 'feathers-errors';
import parseQuery from './parse';

// Create the service.
class Service {
  constructor(options){
    if(!options){
      throw new SyntaxError('RethinkDB options have to be provided.');
    }

    if (options.Model) {
      options.r = options.Model;
    } else {
      throw new SyntaxError('You must provide the RethinkDB object on options.Model');
    }

    // Make sure the user connected a database before creating the service.
    if (!options.r._poolMaster._options.db) {
      throw new SyntaxError('You must provide either an instance of r that is preconfigured with a db, or a provide options.db.');
    }

    if (!options.name) {
      throw new SyntaxError('You must provide a table name on options.name');
    }

    this.type = 'rethinkdb';
    this.id = options.id || 'id';
    this.table = options.r.table(options.name);
    this.options = options;
    this.paginate = options.paginate || {};
  }

  extend(obj) {
    return Proto.extend(obj, this);
  }

  _find(params = {}) {
    var r = this.options.r;
    return new Promise((resolve, reject) => {
      params.query = params.query || {};

      // Start with finding all, and limit when necessary.
      var query = this.table.filter({}),
        // Prepare the special query params.
        filters = filter(params.query, this.paginate);

      // Handle $select
      if (filters.$select) {
        query = query.pluck(filters.$select);
      }

      // Handle $sort
      if (filters.$sort){
        var fieldName = Object.keys(filters.$sort)[0];
        if (filters.$sort[fieldName] === 1) {
          query = query.orderBy(fieldName);
        } else {
          query = query.orderBy(r.desc(fieldName));
        }
      }

      // Handle $or
      // TODO (@marshallswain): Handle $or queries with nested specials.
      // Right now they won't work and we'd need to start diving
      // into nested where conditions.
      if (params.query.$or) {
        // orQuery will be built and passed to row('rowName').filter().
        var orQuery;
        // params.query.$or looks like [ { name: 'Alice' }, { name: 'Bob' } ]
        // Needs to become:
        // r.row("name").eq('Alice').or(r.row("name").eq('Bob'))
        params.query.$or.forEach((queryObject, i) => {
          // queryObject looks like { name: 'Alice' }
          var keys = Object.keys(queryObject);

          keys.forEach(qField => {
            // The queryObject's value: 'Alice'
            let qValue = queryObject[qField];

            // Build the subQuery based on the qField.
            var subQuery;
            // If the qValue is an object, it will have special params in it.
            if (typeof qValue !== 'object') {
              subQuery = r.row(qField).eq(qValue);
            }

            // At the end of the current set of attributes, determine placement.
            if (i === 0) {
              orQuery = subQuery;
            } else {
              orQuery = orQuery.or(subQuery);
            }
          });
        });
        query = query.filter(orQuery);
        delete params.query.$or;
      }
      query = parseQuery(this, query, params.query);

      var countQuery;

      // For pagination, count has to run as a separate query, but without limit.
      if (this.paginate.default) {
        countQuery = query.count().run();
      }

      // Handle $skip AFTER the count query but BEFORE $limit.
      if (filters.$skip){
        query = query.skip(filters.$skip);
      }
      // Handle $limit AFTER the count query and $skip.
      if (filters.$limit){
        query = query.limit(filters.$limit);
      }

      // Execute the query
      return Promise.all([query, countQuery]).then(responses => {
        let data = responses[0];
        // if (this.options.returnCursors) {
        //   return callback(err, cursor);
        // }
        if (this.paginate.default) {
          data = {
            total: responses[1],
            limit: filters.$limit,
            skip: filters.$skip || 0,
            data
          };
        }


        return resolve(data);
      })
      .catch(err => reject(err));
    });
  }

  find(params){
    return this._find(params);
  }

  get(id, params) {
    return new Promise((resolve, reject) => {
      let query;
      // If an id was passed, just get the record.
      if (id !== null && id !== undefined) {
        query = this.table.get(id);

      // If no id was passed, use params.query
      } else {
        params = params || {query:{}};
        query = this.table.filter(params.query).limit(1);
      }

      query.run()
        .then(data => {
          if (Array.isArray(data)) {
            data = data[0];
          }
          if(!data) {
            return reject(new errors.NotFound(`No record found for id '${id}'`));
          }
          return resolve(data);
        })
        .catch(reject);
    });
  }

  // STILL NEED TO ADD params argument here.
  create(data) {
    return new Promise((resolve, reject) => {
      this.table.insert(data).run()
        .then(res => {
          data.id = res.generated_keys[0];
          return resolve(data);
        })
        .catch(reject);
    });
  }

  patch(id, data, params) {
    return new Promise((resolve, reject) => {
      let query;
      if (id !== null && id !== undefined) {
        query = this.get(id);
      } else if (params) {
        query = this.find(params);
      } else {
        return reject(new Error('Patch requires an ID or params'));
      }
      // Find the original record(s), first, then patch them.
      query.then(getData => {
        let query;
        if (Array.isArray(getData)) {
          let ids = getData.map(item => item.id);
          query = this.table.getAll(...ids);
        } else {
          query = this.table.get(id);
        }
        query.update(data, {returnChanges: true}).run()
          .then(response => {
            let changes = response.changes.map(change => change.new_val);
            resolve(changes.length === 1 ? changes[0] : changes);
          })
          .catch(reject);
      })
      .catch(reject);
    });
  }

  update(id, data) {
    return new Promise((resolve, reject) => {
      // Find the original record, first, then update it.
      this.get(id)
        .then(getData => {
          data.id = id;
          this.table.get(getData.id).replace(data, {returnChanges: true}).run()
            .then(result => resolve(result.changes[0].new_val))
            .catch(reject);
        })
        .catch(reject);
      });
  }

  remove(id, params) {
    return new Promise((resolve, reject) => {
      let query;

      // You have to pass id=null to remove all records.
      if (id !== null && id !== undefined) {
        query = this.table.get(id);
      } else if (id === null) {
        const queryParams = Object.assign({}, params && params.query);
        query = this.table.filter(queryParams);
      } else {
        return reject(new Error('You must pass either an id or params to remove.'));
      }
      query.delete({returnChanges: true}).run()
        .then(res => {
          if (res.changes && res.changes.length) {
            let changes = res.changes.map(change => change.old_val);
            return resolve(changes.length === 1 ? changes[0] : changes);
          } else {
            return resolve([]);
          }
        })
        .catch(reject);
    });
  }
}

export default function init(options) {
  return new Service(options);
}

init.Service = Service;
